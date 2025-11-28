import { calculateEAR, calculateMAR, LANDMARKS } from './vision-logic.js';
import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES DE FÁBRICA (Fallback) ---
const FACTORY_CONFIG = {
    CRITICAL_TIME_MS: 20000,   // 20s = Alarme Máximo (Sono Profundo)
    MICROSLEEP_TIME_MS: 3000,  // 3s = Alarme Intermediário (Só se já tiver piscadas)
    LONG_BLINK_TIME_MS: 400,   // 400ms = Duração de uma piscada de sono
    REQUIRED_LONG_BLINKS: 3,   // Quantidade de piscadas para armar o sistema
    BLINK_WINDOW_MS: 15000,    // 15s para resetar a contagem se o motorista acordar
    EAR_THRESHOLD: 0.25,       // Ajustado na calibração
    MAR_THRESHOLD: 0.50,       // Ajustado na calibração
    role: 'MOTORISTA'
};

export class DrowsinessDetector {
    constructor(audioManager, onStatusChange) {
        this.audioManager = audioManager;
        this.onStatusChange = onStatusChange;
        
        // Carrega configurações padrão
        this.config = { ...FACTORY_CONFIG };

        // Estado inicial
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
        const calibratedEAR = earClosed + (earOpen - earClosed) * 0.2;
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

    // --- A FUNÇÃO QUE ESTAVA FALTANDO ---
    processDetection(ear, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) {
            // Se não calibrado, apenas ignora
            return;
        }

        const now = Date.now();
        const { EAR_THRESHOLD, CRITICAL_TIME_MS, MICROSLEEP_TIME_MS, LONG_BLINK_TIME_MS, REQUIRED_LONG_BLINKS, BLINK_WINDOW_MS } = this.config;

        // Reset da janela de tempo (zera contagem se passar 15s sem incidentes)
        if (now - this.state.longBlinksWindowStart > BLINK_WINDOW_MS) {
            if (this.state.longBlinksCount > 0) {
                this.state.longBlinksCount = 0;
            }
            this.state.longBlinksWindowStart = now;
        }

        // --- LÓGICA DE OLHOS FECHADOS ---
        if (ear < EAR_THRESHOLD) {
            if (this.state.eyesClosedSince === null) {
                this.state.eyesClosedSince = now;
            }

            const timeClosed = now - this.state.eyesClosedSince;
            const isSystemArmed = this.state.longBlinksCount >= REQUIRED_LONG_BLINKS;
            
            // 1. Contabiliza Piscada Longa (Silencioso até o limite)
            if (timeClosed >= LONG_BLINK_TIME_MS && !this.state.justTriggeredLongBlink) {
                this.triggerLongBlink();
            }

            // 2. Alarmes de Tempo (Crítico e Microssono)
            if (timeClosed >= CRITICAL_TIME_MS) {
                // Nível 2: 20s fechado direto (Dormiu)
                this.triggerAlarm("PERIGO: SONO PROFUNDO (20s)");
            } else if (isSystemArmed && timeClosed >= MICROSLEEP_TIME_MS) {
                // Nível 1: 3s fechado (Só toca se já acumulou 3 piscadas)
                this.triggerAlarm("MICROSSONO DETECTADO (FADIGA ALTA)");
            }

        } 
        // --- LÓGICA DE OLHOS ABERTOS ---
        else {
            if (this.state.eyesClosedSince !== null) {
                this.state.eyesClosedSince = null;
                this.state.justTriggeredLongBlink = false;

                // Se o alarme não está tocando, atualiza status visual
                if (!this.state.isAlarmActive) {
                    if (this.state.longBlinksCount >= REQUIRED_LONG_BLINKS) {
                        this.updateUI("ALERTA: FADIGA ALTA. PRÓXIMO FECHAMENTO DISPARA.");
                    } else {
                        this.updateUI("Monitorando...");
                    }
                } else {
                    // Se abriu o olho e estava tocando alarme, para o som
                    this.stopAlarm();
                }
            }
        }
        
        // Atualiza os contadores na tela (ex: 1/3)
        if (!this.state.isAlarmActive) {
            this.updateUICounters();
        }
    }

    triggerLongBlink() {
        this.state.longBlinksCount++;
        this.state.justTriggeredLongBlink = true; // Trava para não contar a mesma piscada 2x
        
        // Apenas atualiza visualmente, não toca som ainda (exceto se for o trigger do 3/3)
        this.updateUICounters(); 
    }

    triggerAlarm(reason) {
        if (!this.state.isAlarmActive) {
            console.log(reason);
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
            this.onStatusChange({ alarm: true, text: reason });
            
            // Log no Firebase
            if(auth.currentUser) {
                db.collection('logs').add({
                    uid: auth.currentUser.uid,
                    timestamp: new Date(),
                    type: "ALARM",
                    reason: reason,
                    role: this.config.role
                });
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
        
        // Atualiza números
        const counterEl = document.getElementById('blink-counter');
        if(counterEl) counterEl.innerText = `${count}/${max}`;
        
        // Atualiza Badge Colorida
        const levelEl = document.getElementById('fatigue-level');
        if(levelEl) {
            if (count >= max) {
                levelEl.innerText = "FADIGA";
                levelEl.className = "value danger";
            } else if (count > 0) {
                levelEl.innerText = "ATENÇÃO";
                levelEl.className = "value warning"; // Se não tiver classe warning no CSS, ele vai ficar branco/padrão, adicione se quiser amarelo
            } else {
                levelEl.innerText = "ATIVO";
                levelEl.className = "value safe";
            }
        }
    }
}