import { calculateEAR, calculateMAR, LANDMARKS } from './vision-logic.js';
import { db, auth } from './firebase-config.js';

export class DrowsinessDetector {
    constructor(audioManager, onStatusChange) {
        this.audioManager = audioManager;
        this.onStatusChange = onStatusChange; // Callback para atualizar UI
        
        // CONFIGURAÇÕES PADRÃO (serão sobrescritas pela calibração)
        this.config = {
            EAR_THRESHOLD: 0.25,
            MAR_THRESHOLD: 0.50,
            // 20 segundos @ 30fps (aprox) = 600 frames. 
            // Porém, JS não é fps fixo. Usaremos timestamps para precisão.
            CRITICAL_TIME_MS: 3000, // 20 segundos para alarme FINAL
            LONG_BLINK_TIME_MS: 400, // 400ms = piscada longa (sinal de sono)
            REQUIRED_LONG_BLINKS: 3  // Precisa de 3 sinais para armar o sistema
        };

        // Estado do Sistema
        this.state = {
            isCalibrated: false,
            eyesClosedSince: null,
            longBlinksCount: 0,
            longBlinksWindowStart: Date.now(),
            isAlarmActive: false,
            monitoring: false
        };
    }

    setCalibration(earClosed, earOpen, marOpen) {
        // Lógica de Threshold igual ao seu Python
        this.config.EAR_THRESHOLD = earClosed + (earOpen - earClosed) * 0.2;
        this.config.MAR_THRESHOLD = marOpen * 0.5;
        this.state.isCalibrated = true;
        
        // Salva no Firebase
        if(auth.currentUser) {
            db.collection('users').doc(auth.currentUser.uid).set({
                calibration: this.config
            }, { merge: true });
        }
        console.log("Sistema Calibrado:", this.config);
    }

    processLandmarks(landmarks) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const leftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        const rightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        const now = Date.now();

        // --- LÓGICA DE DETECÇÃO ---

        if (avgEAR < this.config.EAR_THRESHOLD) {
            // Olhos Fechados
            if (this.state.eyesClosedSince === null) {
                this.state.eyesClosedSince = now;
            }

            const closedDuration = now - this.state.eyesClosedSince;

            // 1. Verifica se já atingiu o tempo CRÍTICO (20s)
            // SÓ DISPARA SE já tivermos acumulado piscadas longas (Sinais de fadiga)
            if (this.state.longBlinksCount >= this.config.REQUIRED_LONG_BLINKS) {
                if (closedDuration > this.config.CRITICAL_TIME_MS) {
                    this.triggerAlarm("CRÍTICO: Olhos fechados por 20s!");
                }
            } else {
                // Se não tem piscadas longas suficientes, ainda não dispara o de 20s (evita falso positivo se o cara só estiver olhando pra baixo limpando algo rápido, mas idealmente 20s é muito tempo kkk)
                // Numa situação real de direção, 20s é morte. Mas estou seguindo a regra.
                // Vou adicionar um fallback: Se passar de 25s, toca mesmo sem validação.
                 if (closedDuration > 25000) this.triggerAlarm("FALLBACK: Olhos fechados tempo excessivo!");
            }

        } else {
            // Olhos Abertos -> Analisa o que aconteceu
            if (this.state.eyesClosedSince !== null) {
                const duration = now - this.state.eyesClosedSince;
                
                // Foi uma piscada longa? (Entre 400ms e 2s)
                if (duration > this.config.LONG_BLINK_TIME_MS && duration < 2000) {
                    this.registerLongBlink();
                }
                
                this.state.eyesClosedSince = null;
                this.stopAlarm(); // Se abriu o olho, para o alarme
            }
        }
        
        // Reset da janela de tempo de piscadas longas (Ex: Zera contagem a cada 2 mins)
        if (now - this.state.longBlinksWindowStart > 120000) {
            this.state.longBlinksCount = 0;
            this.state.longBlinksWindowStart = now;
            this.updateUI("Fadiga Resetada");
        }
    }

    registerLongBlink() {
        this.state.longBlinksCount++;
        this.updateUI(`Sinal de Sono detectado! (${this.state.longBlinksCount}/3)`);
        
        // Feedback sonoro sutil (opcional) ou visual
        // Se chegou no limite de validação
        if (this.state.longBlinksCount >= this.config.REQUIRED_LONG_BLINKS) {
            this.updateUI("ALERTA: FADIGA ALTA. PRÓXIMO FECHAMENTO DISPARA ALARME.");
        }
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
                    reason: reason
                });
            }
        }
    }

    stopAlarm() {
        if (this.state.isAlarmActive) {
            this.state.isAlarmActive = false;
            this.audioManager.stopAlert();
            this.onStatusChange({ alarm: false, text: "Monitorando..." });
        }
    }

    updateUI(statusText) {
        this.onStatusChange({ 
            alarm: this.state.isAlarmActive, 
            text: statusText, 
            blinks: this.state.longBlinksCount 
        });
    }
}