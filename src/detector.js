import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES PADRÃO ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 15000,
    MICROSLEEP_TIME_MS: 5000,       
    HEAD_DOWN_TIME_MS: 25000,      
    HEAD_CRITICAL_TIME_MS: 120000,   

    NO_DETECTION_ALARM_MS: 900000, // 15min (900000ms) pra produção
    TEST_NO_DETECTION_MS: 5000,
    
    LONG_BLINK_TIME_MS: 1300,
    BLINK_WINDOW_MS: 30000,
    
    YAWN_TIME_MS: 4000,
    YAWN_RESET_TIME: 5000,

    EAR_THRESHOLD: 0.22,
    MAR_THRESHOLD: 0.80, 
    HEAD_RATIO_THRESHOLD: 0.85,
    
    REQUIRED_LONG_BLINKS: 5,        
    REQUIRED_YAWNS: 5,   
    
    VERSION: "3.1.5",
    
    role: 'VIGIA'
};

export class DrowsinessDetector {
    constructor(audioManager, onStatusChange) {
        this.audioManager = audioManager;
        this.onStatusChange = onStatusChange;
        this.config = { ...FACTORY_CONFIG };
        this.lastProcessTime = Date.now();

        this.state = {
            isCalibrated: false,
            eyesClosedSince: null,
            longBlinksCount: 0,
            longBlinksWindowStart: Date.now(),
            recoveryFrames: 0, 

            isYawning: false,
            mouthOpenSince: null,
            lastYawnTime: 0,
            yawnCount: 0,

            headDownSince: null,
            isHeadDown: false,
            hasLoggedHeadDown: false,      
            hasLoggedHeadCritical: false,  
            headRecoveryFrames: 0, 

            lastFaceDetectedAt: Date.now(),
            hasLoggedNoDetection: false,

            isAlarmActive: false,
            monitoring: false,
            justTriggeredLongBlink: false,
            hasLoggedFatigue: false,
            lastLogTimestamp: 0, 

            lastUiBlink: -1,
            lastUiYawn: -1,
            lastUiText: ""
        };

        // Microssono desativado: Removido buffer de memória e timers
    }

    setRole(newRole) {
        this.config.role = newRole;
    }

    setCalibration(earClosed, earOpen, marOpen, headRatioNormal) {
        const newEAR = earClosed + (earOpen - earClosed) * 0.35;
        const newMAR = Math.max(marOpen * 0.75, 0.55);
        const newHead = headRatioNormal * 0.88; 

        this.config.EAR_THRESHOLD = newEAR;
        this.config.MAR_THRESHOLD = newMAR;
        this.config.HEAD_RATIO_THRESHOLD = newHead;
        
        this.state.isCalibrated = true;
        this.updateUI("SISTEMA CALIBRADO");

        if (auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: { 
                    EAR_THRESHOLD: newEAR, 
                    MAR_THRESHOLD: newMAR,
                    HEAD_RATIO_THRESHOLD: newHead,
                    updatedAt: new Date()
                }
            }, { merge: true })
            .then(() => console.log("✅ Calibração salva no Firestore"))
            .catch(e => console.error("❌ Erro ao salvar calibração:", e));
        }
    }

    resetDetectionTimer() {
        this.state.lastFaceDetectedAt = Date.now();
        this.state.hasLoggedNoDetection = false;
        
        // Se o alarme de "Inatividade" estava tocando e o rosto voltou, paramos o alarme
        if (this.state.isAlarmActive && this.state.lastUiText.includes("INATIVO")) {
            this.stopAlarm();
        }
    }

    checkInactivity() {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const idleTime = Date.now() - this.state.lastFaceDetectedAt;
        const threshold = 5000; // Seus 5 segundos de teste

        if (idleTime >= threshold) {
            // Se o alarme não está ativo, disparamos novamente
            if (!this.state.isAlarmActive) {
                this.triggerAlarm("SISTEMA INATIVO: NENHUM MOVIMENTO", true);
                // Mantemos a flag como true para o log, mas o áudio voltará a tocar
                this.state.hasLoggedNoDetection = true;
            }
        }
    }

    processHeadTilt(currentRatio, pitchRatio) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const isRatioLow = currentRatio < this.config.HEAD_RATIO_THRESHOLD;
        const isLookingUp = pitchRatio > 2.0; 
        
        const isPhysicallyHeadDown = isRatioLow && !isLookingUp;
        this.state.isHeadDown = isPhysicallyHeadDown;
        
        if (isPhysicallyHeadDown) {
            this.state.headRecoveryFrames = 0;
            if (this.state.headDownSince === null) this.state.headDownSince = Date.now();

            const duration = Date.now() - this.state.headDownSince;

            if (duration >= this.config.HEAD_DOWN_TIME_MS && duration < this.config.HEAD_CRITICAL_TIME_MS) {
                if (!this.state.hasLoggedHeadDown) {
                    this.triggerAlarm(`ATENÇÃO: CABEÇA BAIXA`);
                    this.state.hasLoggedHeadDown = true;
                }
            }
            
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
            }
        }
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const cfg = this.config;

        if (now - this.lastProcessTime > 2000) {
            this.state.eyesClosedSince = null;
            this.state.mouthOpenSince = null;
            this.state.headDownSince = null;
            this.lastProcessTime = now;
            return; 
        }
        this.lastProcessTime = now;

        if (now - this.state.longBlinksWindowStart > cfg.BLINK_WINDOW_MS) {
            this.state.longBlinksCount = 0;
            this.state.yawnCount = 0; 
            this.state.hasLoggedFatigue = false; 
            this.state.longBlinksWindowStart = now;
            this.updateUICounters(); 
        }

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

        if (!isEffectivelyClosed && !this.state.isHeadDown) {
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
            
            if (timeClosed >= cfg.CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // REMOVIDO: triggerMicrosleepEvent
            // O sistema ignora o alerta de 5s, mas continua contando como piscada longa se fechar e abrir.

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

    // REMOVIDO: triggerMicrosleepEvent (Função apagada para economizar recursos)

    async triggerAlarm(reason, playSound = true) {
        const now = Date.now();
        if (now - this.state.lastLogTimestamp < 3000) return; 

        this.state.lastLogTimestamp = now;

        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        this.updateUI(reason); 
        
        if (auth.currentUser && window.captureSnapshot) {
            window.captureSnapshot().then(base64Image => {
                this.logToFirebaseSmart(reason, base64Image);
            });
        } else {
            this.logToFirebaseSmart(reason, null);
        }
    }

    logToFirebaseSmart(reason, snapshotData = null) { 
        if(!auth.currentUser) return;
        const date = new Date();
        db.collection('logs')
            .doc(auth.currentUser.uid)
            .collection('logs') 
            .add({
                timestamp: date,
                type: "ALARM",
                reason: reason,
                role: this.config.role,
                userName: auth.currentUser.displayName,
                uid: auth.currentUser.uid,
                snapshot: snapshotData,
                fatigue_level: `P:${this.state.longBlinksCount} | B:${this.state.yawnCount}`,
                dateStr: `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`
            })
            .catch(e => console.error("Erro Log Firebase:", e));
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