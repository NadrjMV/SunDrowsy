import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES PADRÃO (SAFETY NET) ---
const FACTORY_CONFIG = {
    // Tempos
    CRITICAL_TIME_MS: 10000,        // 10s (Sono)
    MICROSLEEP_TIME_MS: 4500,       // 4.5s (Microssono)
    HEAD_DOWN_TIME_MS: 1000,        // 4s (Cabeça baixa sustentada)
    
    LONG_BLINK_TIME_MS: 700,        // Piscada lenta
    BLINK_WINDOW_MS: 60000,         // Janela de análise de 1min
    
    YAWN_TIME_MS: 1500,             // Bocejo sustentado
    YAWN_RESET_TIME: 5000,          // Cooldown bocejo

    // Limites (Thresholds) - Serão sobrescritos pela calibração
    EAR_THRESHOLD: 0.22,
    MAR_THRESHOLD: 0.50,
    HEAD_RATIO_THRESHOLD: 0.85,     // Padrão conservador
    
    // Contadores Trigger
    REQUIRED_LONG_BLINKS: 5,        
    REQUIRED_YAWNS: 3,              
    
    role: 'VIGIA'
};

export class DrowsinessDetector {
    constructor(audioManager, onStatusChange) {
        this.audioManager = audioManager;
        this.onStatusChange = onStatusChange;
        this.config = { ...FACTORY_CONFIG };

        this.state = {
            isCalibrated: false,
            
            // Olhos
            eyesClosedSince: null,
            longBlinksCount: 0,
            longBlinksWindowStart: Date.now(),
            recoveryFrames: 0, 

            // Bocejo
            isYawning: false,
            mouthOpenSince: null,
            lastYawnTime: 0,
            yawnCount: 0,

            // Cabeça (Head Pose)
            headDownSince: null,
            isHeadDown: false,
            hasLoggedHeadDown: false,

            // Sistema
            isAlarmActive: false,
            monitoring: false,
            justTriggeredLongBlink: false,
            hasLoggedFatigue: false,
            lastLogTimestamp: 0, 

            // Cache UI
            lastUiBlink: -1,
            lastUiYawn: -1,
            lastUiText: ""
        };
    }

    setRole(newRole) {
        this.config.role = newRole;
    }

    // *** ATUALIZADO: Recebe valores brutos e calcula as margens ***
    setCalibration(earClosed, earOpen, marOpen, headRatioNormal) {
        // EAR: Margem de 25% acima do olho fechado (evita falso positivo se olho for "caído")
        const newEAR = earClosed + (earOpen - earClosed) * 0.50;
        
        // MAR: 60% da abertura máxima do bocejo
        const newMAR = marOpen * 0.60;
        
        // HEAD: 85% do ratio normal. Se cair abaixo disso, é cabeça baixa.
        // Ex: Normal 0.90 -> Trigger em 0.76
        const newHead = headRatioNormal * 0.90;

        this.config.EAR_THRESHOLD = newEAR;
        this.config.MAR_THRESHOLD = newMAR;
        this.config.HEAD_RATIO_THRESHOLD = newHead;
        
        this.state.isCalibrated = true;
        
        console.log(`📏 CALIBRAÇÃO APLICADA:`);
        console.log(`   EAR (Olhos): ${newEAR.toFixed(3)}`);
        console.log(`   MAR (Boca):  ${newMAR.toFixed(3)}`);
        console.log(`   HEAD (Ratio): ${newHead.toFixed(3)} (Normal era ${headRatioNormal.toFixed(3)})`);
        
        this.updateUI("SISTEMA CALIBRADO");

        // Persiste no Firebase para não perder se der F5
        if(auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: { 
                    EAR_THRESHOLD: newEAR, 
                    MAR_THRESHOLD: newMAR,
                    HEAD_RATIO_THRESHOLD: newHead
                }
            }, { merge: true }).catch(e => console.error("Erro ao salvar calibração:", e));
        }
    }

    // Lógica Específica de Cabeça
    processHeadTilt(currentRatio, pitchRatio) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        // 1. Detecta Trigger Principal (Sua configuração de 1.33)
        const isRatioLow = currentRatio < this.config.HEAD_RATIO_THRESHOLD;
        
        // 2. Filtro de Segurança ("Olhando para Cima")
        // Baseado em anatomia: Quando olhamos pra cima, a distância nariz-queixo aumenta drasticamente
        // Um valor > 2.2 geralmente indica que a pessoa está olhando para cima.
        // Um valor < 1.4 geralmente indica cabeça baixa (queixo colado no peito).
        const isLookingUp = pitchRatio > 2.0; 

        // Só consideramos cabeça baixa se o ratio estiver baixo E NÃO estiver olhando pra cima
        const isHeadDown = isRatioLow && !isLookingUp;
        
        // --- VISUAL DEBUG (Opcional: Ver no console se o bloqueio funcionou) ---
        // if (isRatioLow && isLookingUp) console.log("🛡️ ALARME BLOQUEADO: Usuário olhando para cima.");

        if (isHeadDown) {
            this.state.headRecoveryFrames = 0;

            if (this.state.headDownSince === null) {
                this.state.headDownSince = Date.now();
            }

            const duration = Date.now() - this.state.headDownSince;

            if (duration >= this.config.HEAD_DOWN_TIME_MS) {
                if (!this.state.hasLoggedHeadDown) {
                    this.triggerAlarm(`PERIGO: CABEÇA BAIXA`);
                    this.state.hasLoggedHeadDown = true;
                    this.state.isHeadDown = true; 
                }
            }
        } else {
            this.state.headRecoveryFrames++;

            if (this.state.headRecoveryFrames > 5) {
                this.state.headDownSince = null;
                this.state.hasLoggedHeadDown = false;
                this.state.isHeadDown = false;
                
                if (this.state.isAlarmActive && 
                    this.state.longBlinksCount < this.config.REQUIRED_LONG_BLINKS && 
                    this.state.yawnCount < this.config.REQUIRED_YAWNS) {
                    this.stopAlarm();
                }
            }
        }
    }

    // Lógica Principal (Olhos e Boca)
    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const cfg = this.config;

        // 1. Reset Janela de Tempo (60s)
        if (now - this.state.longBlinksWindowStart > cfg.BLINK_WINDOW_MS) {
            this.state.longBlinksCount = 0;
            this.state.yawnCount = 0; 
            this.state.hasLoggedFatigue = false; 
            this.state.longBlinksWindowStart = now;
            this.updateUICounters(); 
        }

        // 2. Bocejo
        if (mar > cfg.MAR_THRESHOLD) {
            if (this.state.mouthOpenSince === null) this.state.mouthOpenSince = now;
            if ((now - this.state.mouthOpenSince) >= cfg.YAWN_TIME_MS && !this.state.isYawning) {
                if (now - this.state.lastYawnTime > cfg.YAWN_RESET_TIME) this.triggerYawn();
            }
        } else {
            this.state.mouthOpenSince = null;
            this.state.isYawning = false;
        }

        // 3. Olhos (Com filtro de recuperação para evitar flicker)
        const isClosed = (leftEAR < cfg.EAR_THRESHOLD) && (rightEAR < cfg.EAR_THRESHOLD);
        let isEffectivelyClosed = isClosed;

        if (!isClosed && this.state.eyesClosedSince !== null && this.state.recoveryFrames < 5) {
            // Se abriu o olho por apenas 1-4 frames, considera fechado ainda (flicker)
            isEffectivelyClosed = true;
            this.state.recoveryFrames++;
        } else if (!isClosed) {
            isEffectivelyClosed = false;
        } else {
            this.state.recoveryFrames = 0;
        }

        if (isEffectivelyClosed) {
            if (this.state.eyesClosedSince === null) this.state.eyesClosedSince = now;
            const timeClosed = now - this.state.eyesClosedSince;
            
            // Nível 1: Sono Profundo (10s ou mais direto)
            if (timeClosed >= cfg.CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO DETECTADO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // Nível 2: Microssono (Se já estiver cansado)
            if (this.state.longBlinksCount >= 2 && timeClosed >= cfg.MICROSLEEP_TIME_MS) {
                this.triggerAlarm(`MICROSSONO DETECTADO`);
                return;
            }

            // Contabiliza Piscada Longa
            if (timeClosed >= cfg.LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }
        } else {
            if (this.state.eyesClosedSince !== null) {
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;
                this.state.recoveryFrames = 0;
                this.checkFatigueAccumulation();
            } else {
                // Se alarme toca e não tem motivo (cabeça levantada, olhos abertos), corta.
                if (this.state.isAlarmActive && !this.state.isHeadDown) this.stopAlarm();
            }
        }
        
        if (!this.state.isAlarmActive) this.updateUICounters();
    }

    triggerYawn() {
        this.state.isYawning = true;
        this.state.yawnCount++;
        this.state.lastYawnTime = Date.now();
        this.updateUICounters();
        this.checkFatigueAccumulation();
    }

    triggerLongBlink() {
        this.state.longBlinksCount++;
        this.state.justTriggeredLongBlink = true;
        this.updateUICounters();
    }

    checkFatigueAccumulation() {
        if (this.state.isAlarmActive) return;

        const highFatigue = (this.state.longBlinksCount >= this.config.REQUIRED_LONG_BLINKS) || 
                            (this.state.yawnCount >= this.config.REQUIRED_YAWNS);

        if (highFatigue) {
            this.updateUI("ALERTA: FADIGA ALTA");
            if (!this.state.hasLoggedFatigue) {
                let reason = "FADIGA ACUMULADA";
                if (this.state.yawnCount >= this.config.REQUIRED_YAWNS) reason = "EXCESSO DE BOCEJO";
                else reason = "PISCADAS LENTAS";
                
                this.triggerAlarm(reason, true); // True para tocar som
                this.state.hasLoggedFatigue = true;
            }
        } else {
            this.updateUI("Monitorando...");
        }
    }

    triggerAlarm(reason, playSound = true) {
        const now = Date.now();
        if (now - this.state.lastLogTimestamp < 3000) return; 

        console.warn("🚨 ALARME DISPARADO:", reason);
        this.state.lastLogTimestamp = now;

        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        this.updateUI(reason); 
        
        // --- OTIMIZAÇÃO: FIREBASE EM BACKGROUND ---
        // Envolvemos em setTimeout para jogar a execução para o final da fila de eventos
        // liberando a thread para renderizar o próximo frame da câmera imediatamente.
        if(auth.currentUser) {
            setTimeout(() => {
                const date = new Date();
                const folder = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
                
                // Preparar dados antes
                const payload = {
                    timestamp: date,
                    type: "ALARM",
                    reason: reason,
                    role: this.config.role,
                    fatigue_level: `P:${this.state.longBlinksCount} | B:${this.state.yawnCount}`,
                    userName: auth.currentUser.displayName || 'Usuário',
                    uid: auth.currentUser.uid
                };

                db.collection('logs')
                    .doc(auth.currentUser.uid)
                    .collection(folder)
                    .add(payload)
                    .catch(e => console.error("Erro Log Firebase:", e));
            }, 0);
        }
    }

    stopAlarm() {
        if (this.state.isAlarmActive) {
            this.state.isAlarmActive = false;
            this.audioManager.stopAlert();
            this.updateUI("Monitorando...");
            this.onStatusChange({ alarm: false, text: "Monitorando..." });
        }
    }

    // UI Updates (Otimizado com cache para não travar DOM)
    updateUI(text) {
        if (this.state.lastUiText === text) return; 
        this.state.lastUiText = text;

        const el = document.getElementById('system-status');
        if(el) el.innerText = text;
        
        const overlay = document.getElementById('danger-alert');
        if(overlay) {
            if (this.state.isAlarmActive) {
                overlay.classList.remove('hidden');
                // Injeta o motivo no overlay
                const p = overlay.querySelector('p');
                if(p) p.innerText = text;
            } else {
                overlay.classList.add('hidden');
            }
        }
    }

    updateUICounters() {
        const blink = this.state.longBlinksCount;
        const yawn = this.state.yawnCount;

        if (this.state.lastUiBlink === blink && this.state.lastUiYawn === yawn) return;
        this.state.lastUiBlink = blink;
        this.state.lastUiYawn = yawn;

        const counterEl = document.getElementById('blink-counter');
        const levelEl = document.getElementById('fatigue-level');
        
        if(counterEl) counterEl.innerText = `P: ${blink} | B: ${yawn}`;
        
        if(levelEl) {
            if (blink >= this.config.REQUIRED_LONG_BLINKS || yawn >= this.config.REQUIRED_YAWNS) {
                levelEl.innerText = "FADIGA";
                levelEl.className = "value danger";
            } else if (blink > 0 || yawn > 0) {
                levelEl.innerText = "ATENÇÃO";
                levelEl.className = "value warning"; 
            } else {
                levelEl.innerText = "ATIVO";
                levelEl.className = "value safe";
            }
        }
    }
}