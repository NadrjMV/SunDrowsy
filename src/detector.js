import { calculateEAR, calculateMAR, LANDMARKS } from './vision-logic.js';
import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES DE FÁBRICA ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 5000,
    MICROSLEEP_TIME_MS: 3000,
    LONG_BLINK_TIME_MS: 1100,
    REQUIRED_LONG_BLINKS: 3,
    BLINK_WINDOW_MS: 15000,
    EAR_THRESHOLD: 0.25,
    MAR_THRESHOLD: 0.50,
    role: 'VIGIA'
};

// A CLASSE PRECISA TER A PALAVRA "export" NA FRENTE
export class DrowsinessDetector {
    constructor(audioManager, onStatusChange) {
        this.audioManager = audioManager;
        this.onStatusChange = onStatusChange;
        this.config = { ...FACTORY_CONFIG };

        this.state = {
            isCalibrated: false,
            eyesClosedSince: null,
            longBlinksCount: 0,
            longBlinksWindowStart: Date.now(),
            isAlarmActive: false,
            monitoring: false,
            justTriggeredLongBlink: false,
            recoveryFrames: 0,
            hasLoggedFatigue: false // Trava para evitar spam de logs
        };
    }

    setRole(newRole) {
        this.config.role = newRole;
        console.log(`[SISTEMA] Perfil definido: ${newRole}`);
    }

    setCalibration(earClosed, earOpen, marOpen) {
        const calibratedEAR = earClosed + (earOpen - earClosed) * 0.35;
        const calibratedMAR = marOpen * 0.5;

        this.config.EAR_THRESHOLD = calibratedEAR;
        this.config.MAR_THRESHOLD = calibratedMAR;
        this.state.isCalibrated = true;
        
        console.log(`✅ Calibrado Localmente! Limite EAR: ${calibratedEAR.toFixed(4)}`);

        if(auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: {
                    EAR_THRESHOLD: calibratedEAR,
                    MAR_THRESHOLD: calibratedMAR
                }
            }, { merge: true })
            .then(() => console.log("☁️ Calibração salva."))
            .catch((error) => console.error("❌ Erro calibração:", error));
        }
        
        this.updateUI("Calibração concluída. Monitorando...");
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const { EAR_THRESHOLD, CRITICAL_TIME_MS, MICROSLEEP_TIME_MS, LONG_BLINK_TIME_MS, REQUIRED_LONG_BLINKS, BLINK_WINDOW_MS } = this.config;

        // Reset da Janela de Contagem
        if (now - this.state.longBlinksWindowStart > BLINK_WINDOW_MS) {
            if (this.state.longBlinksCount > 0) {
                this.state.longBlinksCount = 0;
                this.state.hasLoggedFatigue = false; 
            }
            this.state.longBlinksWindowStart = now;
        }

        // Validação Dupla (Anti-ruído)
        const isLeftClosed = leftEAR < EAR_THRESHOLD;
        const isRightClosed = rightEAR < EAR_THRESHOLD;
        const physicallyClosed = isLeftClosed && isRightClosed; 

        let isEffectivelyClosed = false;

        if (physicallyClosed) {
            isEffectivelyClosed = true;
            this.state.recoveryFrames = 0; 
        } else {
            if (this.state.eyesClosedSince !== null && this.state.recoveryFrames < 6) {
                isEffectivelyClosed = true;
                this.state.recoveryFrames++;
            } else {
                isEffectivelyClosed = false;
            }
        }

        // --- LÓGICA DE DETECÇÃO ---
        if (isEffectivelyClosed) {
            if (this.state.eyesClosedSince === null) {
                this.state.eyesClosedSince = now;
            }

            const timeClosed = now - this.state.eyesClosedSince;
            
            // 1. SONO PROFUNDO
            if (timeClosed >= CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // 2. MICROSSONO
            if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS && timeClosed >= MICROSLEEP_TIME_MS) {
                this.triggerAlarm(`MICROSSONO DETECTADO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            }

            // 3. CONTAGEM DE PISCADAS LONGAS
            if (timeClosed >= LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }

        } else {
            if (this.state.eyesClosedSince !== null) {
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;
                this.state.recoveryFrames = 0;

                if (this.state.isAlarmActive) {
                    this.stopAlarm();
                } else {
                    if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS) {
                        this.updateUI("ALERTA: FADIGA ALTA");
                        
                        // Garante o log de fadiga sem spamar
                        if (!this.state.hasLoggedFatigue) {
                            this.triggerAlarm("FADIGA EXCESSIVA (Acúmulo)", false);
                            this.state.hasLoggedFatigue = true;
                        }
                    } else {
                        this.updateUI("Monitorando...");
                    }
                }
            }
        }
        
        if (!this.state.isAlarmActive) this.updateUICounters();
    }

    triggerLongBlink() {
        this.state.longBlinksCount++;
        this.state.justTriggeredLongBlink = true;
        this.updateUICounters();
    }

    triggerAlarm(reason, playSound = true) {
        // Evita tocar áudio repetido se já estiver tocando, mas atualiza o log se necessário
        if (this.state.isAlarmActive && playSound) {
            if (!this.audioManager.isPlaying) this.audioManager.playAlert();
            return;
        }

        console.warn("🚨 ALARME:", reason);
        
        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        
        if(auth.currentUser) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const dateFolder = `${year}-${month}-${day}`;

            db.collection('logs')
                .doc(auth.currentUser.uid)
                .collection(dateFolder)
                .add({
                    timestamp: now,
                    type: "ALARM",
                    reason: reason,
                    role: this.config.role,
                    fatigue_level: `${this.state.longBlinksCount}/${this.config.REQUIRED_LONG_BLINKS}`,
                    userName: auth.currentUser.displayName || 'Usuário',
                    uid: auth.currentUser.uid
                })
                .then(() => console.log("📝 Log salvo."))
                .catch(e => console.error("❌ Erro log:", e));
        }
    }

    stopAlarm() {
        if (this.state.isAlarmActive) {
            this.state.isAlarmActive = false;
            this.audioManager.stopAlert();
            this.updateUI("Monitorando...");
        }
    }

    updateUI(text) {
        const el = document.getElementById('system-status');
        if(el) el.innerText = text;
        const overlay = document.getElementById('danger-alert');
        if(overlay) {
            if (this.state.isAlarmActive) overlay.classList.remove('hidden');
            else overlay.classList.add('hidden');
        }
    }

    updateUICounters() {
        const count = this.state.longBlinksCount;
        const max = this.config.REQUIRED_LONG_BLINKS;
        const counterEl = document.getElementById('blink-counter');
        const levelEl = document.getElementById('fatigue-level');
        
        if(counterEl) counterEl.innerText = `${count}/${max}`;
        
        if(levelEl) {
            if (count >= max) {
                levelEl.innerText = "FADIGA";
                levelEl.className = "value danger";
            } else if (count > 0) {
                levelEl.innerText = "ATENÇÃO";
                levelEl.className = "value warning"; 
            } else {
                levelEl.innerText = "ATIVO";
                levelEl.className = "value safe";
            }
        }
    }
}