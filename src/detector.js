import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES DE FÁBRICA ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 10000,        // 10s (Sono Profundo)
    MICROSLEEP_TIME_MS: 3500,       // 3.5s (Microssono)
    HEAD_DOWN_TIME_MS: 4000,        // 4s (Cabeça baixa)
    LONG_BLINK_TIME_MS: 700,        // 0.7s (Piscada Longa)

    YAWN_TIME_MS: 1500,             
    REQUIRED_YAWNS: 3,              
    YAWN_RESET_TIME: 5000,          

    REQUIRED_LONG_BLINKS: 5,        // 5 piscadas = Fadiga
    BLINK_WINDOW_MS: 60000,         // Janela de 60s

    EAR_THRESHOLD: 0.25,
    MAR_THRESHOLD: 0.50,
    HEAD_RATIO_THRESHOLD: 0.90,     // <--- NOVO (Sobrescrito pela calibração)
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
            
            // Bocejo
            isYawning: false,
            mouthOpenSince: null,
            lastYawnTime: 0,
            yawnCount: 0,

            // Cabeça
            headDownSince: null,
            isHeadDown: false,
            hasLoggedHeadDown: false, 

            // Sistema
            isAlarmActive: false,
            monitoring: false,
            justTriggeredLongBlink: false,
            recoveryFrames: 0,      
            hasLoggedFatigue: false,
            lastLogTimestamp: 0, 

            // CACHE DE UI (Correção do Travamento)
            lastUiBlink: -1,
            lastUiYawn: -1,
            lastUiText: ""
        };
    }

    setRole(newRole) {
        this.config.role = newRole;
        console.log(`[SISTEMA] Perfil definido: ${newRole}`);
    }

    // *** ATUALIZADO: Recebe calibração de cabeça ***
    setCalibration(earClosed, earOpen, marOpen, headRatioNormal) {
        const calibratedEAR = earClosed + (earOpen - earClosed) * 0.35;
        let calibratedMAR = marOpen * 0.60;
        if (calibratedMAR < 0.35) calibratedMAR = 0.35; 

        // CALIBRAÇÃO CABEÇA:
        // Pega o ratio normal (ex: 1.4) e define o limite como 80% disso.
        // Se cair abaixo de 80% do tamanho normal, considera cabeça baixa.
        const calibratedHeadRatio = headRatioNormal * 0.80;

        this.config.EAR_THRESHOLD = calibratedEAR;
        this.config.MAR_THRESHOLD = calibratedMAR;
        this.config.HEAD_RATIO_THRESHOLD = calibratedHeadRatio;
        
        this.state.isCalibrated = true;
        
        // Força atualização da UI
        this.state.lastUiBlink = -1; 
        this.updateUICounters();
        this.updateUI("Calibração concluída. Monitorando...");
        
        console.log(`✅ Calibrado! EAR: ${calibratedEAR.toFixed(3)} | MAR: ${calibratedMAR.toFixed(3)} | HEAD: ${calibratedHeadRatio.toFixed(3)}`);

        // Salva
        if(auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: { 
                    EAR_THRESHOLD: calibratedEAR, 
                    MAR_THRESHOLD: calibratedMAR,
                    HEAD_RATIO_THRESHOLD: calibratedHeadRatio
                }
            }, { merge: true }).catch(e => console.error(e));
        }
    }

    processHeadTilt(tiltData) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        // Usa o ratio atual comparado com o threshold calibrado
        const currentRatio = tiltData.ratio;
        const isHeadDown = currentRatio < this.config.HEAD_RATIO_THRESHOLD;

        this.state.isHeadDown = isHeadDown; 

        if (isHeadDown) {
            if (this.state.headDownSince === null) {
                this.state.headDownSince = Date.now();
            }

            const duration = Date.now() - this.state.headDownSince;

            // Dispara APENAS se ainda não logou este evento específico
            if (duration >= this.config.HEAD_DOWN_TIME_MS && !this.state.hasLoggedHeadDown) {
                this.triggerAlarm(`PERIGO: CABEÇA BAIXA (${(duration/1000).toFixed(1)}s)`);
                this.state.hasLoggedHeadDown = true; 
            }
        } else {
            this.state.headDownSince = null;
            this.state.hasLoggedHeadDown = false; // Reseta trava
        }
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const { EAR_THRESHOLD, MAR_THRESHOLD, CRITICAL_TIME_MS, MICROSLEEP_TIME_MS, 
                LONG_BLINK_TIME_MS, REQUIRED_LONG_BLINKS, BLINK_WINDOW_MS,
                YAWN_TIME_MS, YAWN_RESET_TIME } = this.config;

        // 1. Reset Janela
        if (now - this.state.longBlinksWindowStart > BLINK_WINDOW_MS) {
            this.state.longBlinksCount = 0;
            this.state.yawnCount = 0; 
            this.state.hasLoggedFatigue = false; 
            this.state.longBlinksWindowStart = now;
            this.updateUICounters(); 
        }

        // 2. Bocejo
        if (mar > MAR_THRESHOLD) {
            if (this.state.mouthOpenSince === null) this.state.mouthOpenSince = now;
            const mouthTime = now - this.state.mouthOpenSince;
            if (mouthTime >= YAWN_TIME_MS && !this.state.isYawning) {
                if (now - this.state.lastYawnTime > YAWN_RESET_TIME) this.triggerYawn();
            }
        } else {
            this.state.mouthOpenSince = null;
            this.state.isYawning = false;
        }

        // 3. Olhos
        const isClosed = (leftEAR < EAR_THRESHOLD) && (rightEAR < EAR_THRESHOLD);
        let isEffectivelyClosed = isClosed;

        if (!isClosed && this.state.eyesClosedSince !== null && this.state.recoveryFrames < 6) {
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
            
            if (timeClosed >= CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS && timeClosed >= MICROSLEEP_TIME_MS) {
                this.triggerAlarm(`MICROSSONO DETECTADO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            }
            if (timeClosed >= LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }
        } else {
            if (this.state.eyesClosedSince !== null) {
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;
                this.state.recoveryFrames = 0;
                this.checkFatigueAccumulation();
            } else {
                // Se alarme toca e cabeça NÃO está baixa, para.
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
        if (this.state.isAlarmActive) {
            if (!this.state.isHeadDown) this.stopAlarm();
            return;
        }

        const highFatigue = (this.state.longBlinksCount >= this.config.REQUIRED_LONG_BLINKS) || 
                            (this.state.yawnCount >= this.config.REQUIRED_YAWNS);

        if (highFatigue) {
            this.updateUI("ALERTA: FADIGA ALTA");
            if (!this.state.hasLoggedFatigue) {
                let reason = "FADIGA ACUMULADA";
                if (this.state.yawnCount >= this.config.REQUIRED_YAWNS) reason = "EXCESSO DE BOCEJO";
                else reason = "PISCADAS LENTAS";
                
                this.triggerAlarm(reason, false); 
                this.state.hasLoggedFatigue = true;
            }
        } else {
            this.updateUI("Monitorando...");
        }
    }

    // *** DEBOUNCE ANTI-SPAM ***
    triggerAlarm(reason, playSound = true) {
        const now = Date.now();
        if (this.state.isAlarmActive && playSound && this.audioManager.isPlaying) return;
        
        // Se tentou logar a mesma coisa em menos de 3 segundos, PARA TUDO.
        if (now - this.state.lastLogTimestamp < 3000) return; 

        console.warn("🚨 ALARME:", reason);
        this.state.lastLogTimestamp = now;

        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        
        if(auth.currentUser) {
            const date = new Date();
            const folder = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
            db.collection('logs').doc(auth.currentUser.uid).collection(folder).add({
                timestamp: date,
                type: "ALARM",
                reason: reason,
                role: this.config.role,
                fatigue_level: `P:${this.state.longBlinksCount} | B:${this.state.yawnCount}`,
                userName: auth.currentUser.displayName || 'Usuário',
                uid: auth.currentUser.uid
            }).catch(e => console.error("❌ Erro Log:", e));
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

    // *** UI CACHING PARA EVITAR TRAVAMENTO ***
    updateUI(text) {
        if (this.state.lastUiText === text) return; 
        this.state.lastUiText = text;

        const el = document.getElementById('system-status');
        if(el) el.innerText = text;
        
        const overlay = document.getElementById('danger-alert');
        if(overlay) {
            if (this.state.isAlarmActive) overlay.classList.remove('hidden');
            else overlay.classList.add('hidden');
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
        
        if(counterEl) {
            counterEl.innerText = `P: ${blink} | B: ${yawn}`;
        }
        
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