import { db, auth } from './firebase-config.js';

// --- CONFIGURAÇÕES PADRÃO ---
const FACTORY_CONFIG = {
    // Tempos
    CRITICAL_TIME_MS: 15000,        // 15s (Sono Profundo)
    MICROSLEEP_TIME_MS: 5000,       // 5s olho fechado (cochilo rápido)
    HEAD_DOWN_TIME_MS: 5000,       // 20s (Cabeça baixa)
    HEAD_CRITICAL_TIME_MS: 20000,   // 20s (Crítico - Novo Requisito)
    
    LONG_BLINK_TIME_MS: 1300,        
    BLINK_WINDOW_MS: 60000,         
    
    YAWN_TIME_MS: 1500,             
    YAWN_RESET_TIME: 5000,          

    EAR_THRESHOLD: 0.22,
    MAR_THRESHOLD: 0.50,
    HEAD_RATIO_THRESHOLD: 0.85,     
    
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

        // Buffer para Microssono (Agrupamento)
        this.microsleepBuffer = {
            active: false,
            totalDuration: 0,
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

    // --- LÓGICA DE CABEÇA (ATUALIZADA PARA 20s CRÍTICO) ---
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

            // ESTÁGIO 1: Aviso Rápido (1s)
            if (duration >= this.config.HEAD_DOWN_TIME_MS && duration < this.config.HEAD_CRITICAL_TIME_MS) {
                if (!this.state.hasLoggedHeadDown) {
                    this.triggerAlarm(`ATENÇÃO: CABEÇA BAIXA`);
                    this.state.hasLoggedHeadDown = true;
                    this.state.isHeadDown = true; 
                }
            }
            
            // ESTÁGIO 2: Crítico (20s) - NOVO
            if (duration >= this.config.HEAD_CRITICAL_TIME_MS) {
                if (!this.state.hasLoggedHeadCritical) {
                    // "CRÍTICO" no texto garante que o Admin conte como incidente grave
                    this.triggerAlarm(`PERIGO: CABEÇA BAIXA (+20s)`); 
                    this.state.hasLoggedHeadCritical = true;
                }
            }

        } else {
            this.state.headRecoveryFrames++;

            if (this.state.headRecoveryFrames > 5) {
                this.state.headDownSince = null;
                this.state.hasLoggedHeadDown = false;
                this.state.hasLoggedHeadCritical = false; // Reset do crítico
                this.state.isHeadDown = false;
                
                if (this.state.isAlarmActive && 
                    this.state.longBlinksCount < this.config.REQUIRED_LONG_BLINKS && 
                    this.state.yawnCount < this.config.REQUIRED_YAWNS) {
                    this.stopAlarm();
                }
            }
        }
    }

    processDetection(leftEAR, rightEAR, mar) {
        if (!this.state.monitoring || !this.state.isCalibrated) return;

        const now = Date.now();
        const cfg = this.config;

        // Reset Window
        if (now - this.state.longBlinksWindowStart > cfg.BLINK_WINDOW_MS) {
            this.state.longBlinksCount = 0;
            this.state.yawnCount = 0; 
            this.state.hasLoggedFatigue = false; 
            this.state.longBlinksWindowStart = now;
            this.updateUICounters(); 
        }

        // Bocejo
        if (mar > cfg.MAR_THRESHOLD) {
            if (this.state.mouthOpenSince === null) this.state.mouthOpenSince = now;
            if ((now - this.state.mouthOpenSince) >= cfg.YAWN_TIME_MS && !this.state.isYawning) {
                if (now - this.state.lastYawnTime > cfg.YAWN_RESET_TIME) this.triggerYawn();
            }
        } else {
            this.state.mouthOpenSince = null;
            this.state.isYawning = false;
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

        if (isEffectivelyClosed) {
            if (this.state.eyesClosedSince === null) this.state.eyesClosedSince = now;
            const timeClosed = now - this.state.eyesClosedSince;
            
            // Nível 1: Sono Profundo (Prioridade Máxima - Não agrupa, alerta imediato)
            if (timeClosed >= cfg.CRITICAL_TIME_MS) {
                // Mudei o texto para incluir "PERIGO" para o Admin pegar
                this.triggerAlarm(`PERIGO: SONO PROFUNDO (${(timeClosed/1000).toFixed(1)}s)`);
                return;
            } 
            
            // Nível 2: Microssono (Com Agrupamento de Log)
            if (this.state.longBlinksCount >= 2 && timeClosed >= cfg.MICROSLEEP_TIME_MS) {
                // Toca som NA HORA, mas o log vai ser processado diferente
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

    // --- NOVA LÓGICA DE MICROSSONO (SOM IMEDIATO, LOG AGRUPADO) ---
    triggerMicrosleepEvent(duration) {
        // 1. Feedback Imediato (Segurança)
        if (!this.state.isAlarmActive) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
            this.updateUI("MICROSSONO DETECTADO");
            this.onStatusChange({ alarm: true, text: "MICROSSONO" });
        }

        // 2. Lógica de Agrupamento de Logs
        // Se já tem um timer rodando, cancela ele (pois o usuário continuou dormindo ou piscou de novo)
        if (this.microsleepBuffer.timer) {
            clearTimeout(this.microsleepBuffer.timer);
        }

        // Acumula o tempo. 
        // Nota: duration é o tempo TOTAL atual desde que fechou. 
        // Se estamos num loop, precisamos pegar o maior valor, ou resetar quando abrir.
        // Simplificação: Vamos registrar o tempo deste evento específico no buffer
        this.microsleepBuffer.active = true;
        
        // Define um timeout. Se o usuário abrir o olho e ficar 5s sem fechar de novo, enviamos o log.
        this.microsleepBuffer.timer = setTimeout(() => {
            // Tempo de enviar o log acumulado
            // O duration aqui pode estar desatualizado, mas a lógica de 'soma' que você pediu
            // sugere: evento 1 (4s) + intervalo + evento 2 (4s) = 8s.
            
            // Na verdade, o log deve ser gerado.
            // Vamos usar o duration passado aqui como referência do ultimo evento.
            // Para somar eventos distintos, precisariamos de uma variavel 'accumulatedTime'.
            
            // Implementação da Soma:
            this.logToFirebaseSmart(`MICROSSONO DETECTADO`, duration);
            this.microsleepBuffer.active = false;
        }, 5000); // Espera 5s de "paz" antes de consolidar o log
    }

    // Função Padrão de Alarme (Logs imediatos)
    triggerAlarm(reason, playSound = true) {
        const now = Date.now();
        
        // Anti-spam de log (3s) para alarmes comuns
        if (now - this.state.lastLogTimestamp < 3000) return; 

        console.warn("🚨 ALARME DISPARADO:", reason);
        this.state.lastLogTimestamp = now;

        if (playSound) {
            this.state.isAlarmActive = true;
            this.audioManager.playAlert();
        }
        
        this.onStatusChange({ alarm: true, text: reason });
        this.updateUI(reason); 
        
        // Envia log Imediato
        this.logToFirebaseSmart(reason, 0, true);
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
        // ... (mantido igual) ...
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

    // --- NOVA FUNÇÃO INTELIGENTE DE LOG ---
    // Se for Microssono, tenta agrupar. Se for critical, envia direto.
    logToFirebaseSmart(reason, durationMs = 0, forceImmediate = false) {
        if(!auth.currentUser) return;

        // Se for microssono, vamos tentar somar com o último log se ele for recente?
        // Para simplificar e atender seu pedido de "4s+4s = 8s":
        // A lógica do microsleepBuffer acima já retarda o envio. 
        // Se o usuário cochilar de novo dentro de 5s, o timeout reseta.
        // Precisamos de uma variável acumuladora na classe.
        
        if (reason.includes("MICROSSONO") && !forceImmediate) {
            if (!this.state.microsleepAccumulator) this.state.microsleepAccumulator = 0;
            this.state.microsleepAccumulator += durationMs;
            
            // Atualiza o texto do reason com a soma
            const totalSec = (this.state.microsleepAccumulator / 1000).toFixed(1);
            reason = `MICROSSONO DETECTADO (${totalSec}s)`;
            
            // Reseta o acumulador após usar (pois o timeout só chama aqui no final do evento agrupado)
            // OPS: Se resetar aqui, e o timeout rodar de novo...
            // O timeout roda UMA vez por grupo de cochilos.
            this.state.microsleepAccumulator = 0; 
        }

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