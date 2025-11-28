import { calculateEAR, calculateMAR, LANDMARKS } from './vision-logic.js';
import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES DE FÁBRICA ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 20000,   // 20s = Alarme Máximo (Sono Profundo)
    MICROSLEEP_TIME_MS: 3000,  // 3s = Alarme Intermediário (Só se já tiver piscadas)
    LONG_BLINK_TIME_MS: 400,   // 400ms = Piscada longa
    REQUIRED_LONG_BLINKS: 3,   // Contagem para armar o sistema
    BLINK_WINDOW_MS: 15000,    // 15s para resetar contagem
    EAR_THRESHOLD: 0.25,       // Calibração
    MAR_THRESHOLD: 0.50,       // Calibração
    role: 'MOTORISTA'
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
            justTriggeredLongBlink: false
        };
    }

    setRole(newRole) {
        this.config.role = newRole;
        console.log(`Perfil atualizado: ${newRole}`);
    }

    setCalibration(earClosed, earOpen, marOpen) {
        // Define o limite como 25% acima do olho fechado
        const calibratedEAR = earClosed + (earOpen - earClosed) * 0.25;
        const calibratedMAR = marOpen * 0.5;

        this.config.EAR_THRESHOLD = calibratedEAR;
        this.config.MAR_THRESHOLD = calibratedMAR;
        this.state.isCalibrated = true;
        
        if(auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: this.config
            }, { merge: true });
        }
        
        this.updateUI("Calibração concluída. Monitorando...");
    }

    // --- DETECÇÃO ---
    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const { EAR_THRESHOLD, CRITICAL_TIME_MS, MICROSLEEP_TIME_MS, LONG_BLINK_TIME_MS, REQUIRED_LONG_BLINKS, BLINK_WINDOW_MS } = this.config;

        // Reset da contagem (15s)
        if (now - this.state.longBlinksWindowStart > BLINK_WINDOW_MS) {
            if (this.state.longBlinksCount > 0) this.state.longBlinksCount = 0;
            this.state.longBlinksWindowStart = now;
        }

        // --- VALIDAÇÃO DUPLA (OS DOIS OLHOS FECHADOS) ---
        const isLeftClosed = leftEAR < EAR_THRESHOLD;
        const isRightClosed = rightEAR < EAR_THRESHOLD;
        const bothEyesClosed = isLeftClosed && isRightClosed;

        if (bothEyesClosed) {
            if (this.state.eyesClosedSince === null) {
                this.state.eyesClosedSince = now;
            }

            const timeClosed = now - this.state.eyesClosedSince;
            const isSystemArmed = this.state.longBlinksCount >= REQUIRED_LONG_BLINKS;
            
            // 1. Contagem de Piscada Longa
            if (timeClosed >= LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }

            // 2. Alarmes de Tempo
            if (timeClosed >= CRITICAL_TIME_MS) {
                this.triggerAlarm("PERIGO: SONO PROFUNDO (20s)");
            } else if (isSystemArmed && timeClosed >= MICROSLEEP_TIME_MS) {
                this.triggerAlarm("MICROSSONO DETECTADO (FADIGA ALTA)");
            }

        } else {
            // Se abrir os olhos
            if (this.state.eyesClosedSince !== null) {
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;

                if (!this.state.isAlarmActive) {
                    if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS) {
                        this.updateUI("ALERTA: FADIGA ALTA.");
                    } else {
                        this.updateUI("Monitorando...");
                    }
                } else {
                    this.stopAlarm();
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

    triggerAlarm(reason) {
        if (!this.state.isAlarmActive) {
            console.log(reason);
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
            this.onStatusChange({ alarm: true, text: reason });
            
            // --- NOVA ESTRUTURA DE LOG: logs / {uid} / {data} / {alerta} ---
            if(auth.currentUser) {
                const now = new Date();
                
                // Formata data YYYY-MM-DD
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                const dateFolder = `${year}-${month}-${day}`;

                db.collection('logs')                 // Pasta Raiz: logs
                  .doc(auth.currentUser.uid)          // Pasta do Usuário: UID
                  .collection(dateFolder)             // Pasta do Dia: 2025-11-28
                  .add({                              // Documento do Alerta
                        timestamp: now,
                        type: "ALARM",
                        reason: reason,
                        role: this.config.role,
                        fatigue_level: `${this.state.longBlinksCount}/${this.config.REQUIRED_LONG_BLINKS}`,
                        duration_ms: this.state.eyesClosedSince ? (now - this.state.eyesClosedSince) : 0
                  })
                  .then(() => console.log(`Log salvo em logs/${auth.currentUser.uid}/${dateFolder}`))
                  .catch(e => console.error("Erro ao salvar log:", e));
            }
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
        if(counterEl) counterEl.innerText = `${count}/${max}`;
        
        const levelEl = document.getElementById('fatigue-level');
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