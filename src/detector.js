import { calculateEAR, calculateMAR, LANDMARKS } from './vision-logic.js';
import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES DE FÁBRICA ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 5000,    // 5s pra teste
    MICROSLEEP_TIME_MS: 3000,
    LONG_BLINK_TIME_MS: 1100,
    REQUIRED_LONG_BLINKS: 3,
    BLINK_WINDOW_MS: 15000,
    EAR_THRESHOLD: 0.25,
    MAR_THRESHOLD: 0.50,
    role: 'VIGIA'
};

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
            recoveryFrames: 0 
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
            // Salva APENAS a calibração visual
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: {
                    EAR_THRESHOLD: calibratedEAR,
                    MAR_THRESHOLD: calibratedMAR
                }
            }, { merge: true })
            .then(() => {
                // --- LOG DE SUCESSO DE SALVAMENTO ---
                console.log("☁️ [FIREBASE] Calibração SALVA na nuvem com sucesso!");
                console.log(`   └─ EAR salvo: ${calibratedEAR.toFixed(4)}`);
            })
            .catch((error) => {
                console.error("❌ [FIREBASE] Erro ao salvar calibração:", error);
            });
        }
        
        this.updateUI("Calibração concluída. Monitorando...");
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const { EAR_THRESHOLD, CRITICAL_TIME_MS, MICROSLEEP_TIME_MS, LONG_BLINK_TIME_MS, REQUIRED_LONG_BLINKS, BLINK_WINDOW_MS } = this.config;

        // Reset da Janela
        if (now - this.state.longBlinksWindowStart > BLINK_WINDOW_MS) {
            if (this.state.longBlinksCount > 0) this.state.longBlinksCount = 0;
            this.state.longBlinksWindowStart = now;
        }

        // Validação Dupla
        const isLeftClosed = leftEAR < EAR_THRESHOLD;
        const isRightClosed = rightEAR < EAR_THRESHOLD;
        const physicallyClosed = isLeftClosed && isRightClosed; 

        // Buffer Anti-Ruído
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

        // --- LÓGICA ---
        if (isEffectivelyClosed) {
            if (this.state.eyesClosedSince === null) {
                this.state.eyesClosedSince = now;
        //        console.log(`🔻 Início do fechamento. Limite: ${CRITICAL_TIME_MS}ms`);
            }

            const timeClosed = now - this.state.eyesClosedSince;
            const isSystemArmed = this.state.longBlinksCount >= REQUIRED_LONG_BLINKS;

            if (timeClosed > 1000 && timeClosed % 1000 < 50) {
        //        console.log(`⏱️ Tempo: ${timeClosed}ms`);
            }

            // 1. REGRA DE OURO: TEMPO CRÍTICO (Prioridade)
            if (timeClosed >= CRITICAL_TIME_MS) {
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // 2. REGRA DE MICROSSONO
            if (isSystemArmed && timeClosed >= MICROSLEEP_TIME_MS) {
                this.triggerAlarm(`MICROSSONO DETECTADO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            }

            // 3. CONTAGEM
            if (timeClosed >= LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }

        } else {
            if (this.state.eyesClosedSince !== null) {
            //    console.log(`🔺 Olhos abertos. Reset.`);
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;
                this.state.recoveryFrames = 0;

                if (this.state.isAlarmActive) {
                    this.stopAlarm();
                } else {
                    if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS) {
                        this.updateUI("ALERTA: FADIGA ALTA.");
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
    //    console.log(`⚠️ Piscada Contada: ${this.state.longBlinksCount}`);
        this.updateUICounters();
    }

    triggerAlarm(reason) {
        if (this.state.isAlarmActive) {
            if (!this.audioManager.isPlaying) this.audioManager.playAlert();
            return;
        }

        console.error("🚨 ALARME ACIONADO:", reason);
        this.state.isAlarmActive = true;
        this.audioManager.playAlert();
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
                    duration_ms: (Date.now() - this.state.eyesClosedSince)
                })
                .then(() => console.log("📝 Log de incidente salvo no Firebase."))
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