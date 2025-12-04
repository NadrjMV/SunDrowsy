import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES PADRÃO ---
const FACTORY_CONFIG = {
    // Tempos
    CRITICAL_TIME_MS: 20000,        // 20s (Sono Profundo - Ajustado conforme logs)
    MICROSLEEP_TIME_MS: 5000,       // 5s olho fechado (cochilo rápido)
    HEAD_DOWN_TIME_MS: 10000,       // 10s (Cabeça baixa)
    HEAD_CRITICAL_TIME_MS: 25000,   // 20s (Crítico - Novo Requisito)
    
    LONG_BLINK_TIME_MS: 1300,
    BLINK_WINDOW_MS: 60000,
    
    YAWN_TIME_MS: 4000,
    YAWN_RESET_TIME: 5000,

    EAR_THRESHOLD: 0.22,
    MAR_THRESHOLD: 0.65,
    HEAD_RATIO_THRESHOLD: 0.85,
    
    REQUIRED_LONG_BLINKS: 5,
    REQUIRED_YAWNS: 5,
    
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
            hasLoggedHeadDown: false,      // Log do estagio 1 (1s)
            hasLoggedHeadCritical: false,  // Log do estagio 2 (20s)
            headRecoveryFrames: 0, 

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

        // Buffer para Microssono (Agrupamento Centralizado)
        this.microsleepBuffer = {
            active: false,
            accumulatedTime: 0, // Acumulador real
            timer: null
        };
    }

    setRole(newRole) {
        this.config.role = newRole;
    }

    setCalibration(earClosed, earOpen, marOpen, headRatioNormal) {
        const newEAR = earClosed + (earOpen - earClosed) * 0.35;
        const newMAR = marOpen * 0.60;
        const newHead = headRatioNormal * 0.88; 

        this.config.EAR_THRESHOLD = newEAR;
        this.config.MAR_THRESHOLD = newMAR;
        this.config.HEAD_RATIO_THRESHOLD = newHead;
        
        this.state.isCalibrated = true;
        this.updateUI("SISTEMA CALIBRADO");

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

    // --- LÓGICA DE CABEÇA ---
    processHeadTilt(currentRatio, pitchRatio) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const isRatioLow = currentRatio < this.config.HEAD_RATIO_THRESHOLD;
        const isLookingUp = pitchRatio > 2.0; 
        const isHeadDown = isRatioLow && !isLookingUp;
        
        if (isHeadDown) {
            this.state.headRecoveryFrames = 0;

            if (this.state.headDownSince === null) {
                this.state.headDownSince = Date.now();
            }

            const duration = Date.now() - this.state.headDownSince;

            // ESTÁGIO 1: Aviso Rápido
            if (duration >= this.config.HEAD_DOWN_TIME_MS && duration < this.config.HEAD_CRITICAL_TIME_MS) {
                if (!this.state.hasLoggedHeadDown) {
                    this.triggerAlarm(`ATENÇÃO: CABEÇA BAIXA`);
                    this.state.hasLoggedHeadDown = true;
                    this.state.isHeadDown = true; 
                }
            }
            
            // ESTÁGIO 2: Crítico
            if (duration >= this.config.HEAD_CRITICAL_TIME_MS) {
                if (!this.state.hasLoggedHeadCritical) {
                    this.triggerAlarm(`PERIGO: CABEÇA BAIXA (+20s)`); 
                    this.state.hasLoggedHeadCritical = true;
                }
            }

        } else {
            this.state.headRecoveryFrames++;

            if (this.state.headRecoveryFrames > 5) {
                this.state.headDownSince = null;
                this.state.hasLoggedHeadDown = false;
                this.state.hasLoggedHeadCritical = false;
                this.state.isHeadDown = false;
            }
        }
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const cfg = this.config;

        // Reset janela
        if (now - this.state.longBlinksWindowStart > cfg.BLINK_WINDOW_MS) {
            this.state.longBlinksCount = 0;
            this.state.yawnCount = 0; 
            this.state.hasLoggedFatigue = false; 
            this.state.longBlinksWindowStart = now;
            this.updateUICounters(); 
        }

        // Olhos
        const isClosed = (leftEAR < cfg.EAR_THRESHOLD) && (rightEAR < cfg.EAR_THRESHOLD);
        let isEffectivelyClosed = isClosed;

        if (!isClosed && this.state.eyesClosedSince !== null && this.state.recoveryFrames < 5) {
            isEffectivelyClosed = true;
            this.state.recoveryFrames++;
        } else if (!isClosed) {
            isEffectivelyClosed = false;
        } else {
            this.state.recoveryFrames = 0;
        }

        // Bocejo (ignora quando os olhos estão fechados)
        if (!isEffectivelyClosed) {
            if (mar > cfg.MAR_THRESHOLD) {
                if (this.state.mouthOpenSince === null) this.state.mouthOpenSince = now;
                if ((now - this.state.mouthOpenSince) >= cfg.YAWN_TIME_MS && !this.state.isYawning) {
                    if (now - this.state.lastYawnTime > cfg.YAWN_RESET_TIME) this.triggerYawn();
                }
            } else {
                this.state.mouthOpenSince = null;
                this.state.isYawning = false;
            }
        } else {
            this.state.mouthOpenSince = null;
            this.state.isYawning = false;
        }

        if (isEffectivelyClosed) {
            if (this.state.eyesClosedSince === null) this.state.eyesClosedSince = now;
            const timeClosed = now - this.state.eyesClosedSince;
            
            // Nível 1: Sono Profundo (Prioridade Máxima)
            if (timeClosed >= cfg.CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // Nível 2: Microssono
            if (this.state.longBlinksCount >= 2 && timeClosed >= cfg.MICROSLEEP_TIME_MS) {
                this.triggerMicrosleepEvent(timeClosed);
                return;
            }

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
                
                this.triggerAlarm(reason, true); 
                this.state.hasLoggedFatigue = true;
            }
        } else {
            this.updateUI("Monitorando...");
        }
    }

    // --- MICROSSONO (SOM IMEDIATO, LOG AGRUPADO) ---
    triggerMicrosleepEvent(duration) {
        if (!this.state.isAlarmActive) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
            this.updateUI("MICROSSONO DETECTADO");
            this.onStatusChange({ alarm: true, text: "MICROSSONO" });
        }

        if (this.microsleepBuffer.timer) {
            clearTimeout(this.microsleepBuffer.timer);
        }

        this.microsleepBuffer.active = true;
        
        if (duration > this.microsleepBuffer.accumulatedTime) {
            this.microsleepBuffer.accumulatedTime = duration;
        }
        
        this.microsleepBuffer.timer = setTimeout(() => {
            const totalSec = (this.microsleepBuffer.accumulatedTime / 1000).toFixed(1);
            const reason = `MICROSSONO DETECTADO (${totalSec}s)`;

            this.logToFirebaseSmart(reason);
            
            this.microsleepBuffer.active = false;
            this.microsleepBuffer.accumulatedTime = 0;
            this.microsleepBuffer.timer = null;
        }, 5000); 
    }

    // Função Padrão de Alarme (Logs imediatos COM FOTO)
    async triggerAlarm(reason, playSound = true) {
        const now = Date.now();
        
        // Anti-spam de log (3s)
        if (now - this.state.lastLogTimestamp < 3000) return; 

        console.warn("🚨 ALARME DISPARADO:", reason);
        this.state.lastLogTimestamp = now;

        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        this.updateUI(reason); 
        
        // --- LÓGICA DE SNAPSHOT BASE64 ---
        if (auth.currentUser && window.captureSnapshot) {
            // Captura o frame atual em Base64
            window.captureSnapshot().then(base64Image => {
                // Passa a string gigante direto para o log
                this.logToFirebaseSmart(reason, base64Image);
            });
        } else {
            this.logToFirebaseSmart(reason, null);
        }
    }

    // --- ATUALIZAÇÃO DO LOG (ÚNICA VERSÃO - A CORRETA) ---
    logToFirebaseSmart(reason, snapshotData = null) { 
        if(!auth.currentUser) return;

        setTimeout(() => {
            const date = new Date();
            const folder = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
            
            const payload = {
                timestamp: date,
                type: "ALARM",
                reason: reason,
                role: this.config.role,
                fatigue_level: `P:${this.state.longBlinksCount} | B:${this.state.yawnCount}`,
                userName: auth.currentUser.displayName || 'Usuário',
                uid: auth.currentUser.uid,
                snapshot: snapshotData // <--- AQUI ESTÁ A FOTO SENDO SALVA
            };

            db.collection('logs')
                .doc(auth.currentUser.uid)
                .collection(folder)
                .add(payload)
                .catch(e => console.error("Erro Log Firebase:", e));
        }, 0);
    }

    stopAlarm() {
        if (this.state.isAlarmActive) {
            this.state.isAlarmActive = false;
            this.audioManager.stopAlert();
            this.updateUI("Monitorando...");
            this.onStatusChange({ alarm: false, text: "Monitorando..." });
        }
    }

    updateUI(text) {
        if (this.state.lastUiText === text) return; 
        this.state.lastUiText = text;

        const el = document.getElementById('system-status');
        if(el) el.innerText = text;
        
        const overlay = document.getElementById('danger-alert');
        if(overlay) {
            if (this.state.isAlarmActive) {
                overlay.classList.remove('hidden');
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
                levelEl.innerText = "FADIGA"; levelEl.className = "value danger";
            } else if (blink > 0 || yawn > 0) {
                levelEl.innerText = "ATENÇÃO"; levelEl.className = "value warning"; 
            } else {
                levelEl.innerText = "ATIVO"; levelEl.className = "value safe";
            }
        }
    }
}