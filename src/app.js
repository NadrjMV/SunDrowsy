import { auth, googleProvider, db } from './firebase-config.js';
import { AudioManager } from './audio-manager.js';
import { DrowsinessDetector } from './detector.js'; 
import { LANDMARKS, calculateEAR, calculateMAR, calculateHeadTilt, calculatePitchRatio } from './vision-logic.js';

// --- VARIAVEIS GLOBAIS DE LEITURA INSTANTANEA ---
let currentLeftEAR = 0;
let currentRightEAR = 0;
let currentMAR = 0;
let currentHeadRatio = 0; // Nova variável para cabeça

let lastUiUpdate = 0;

let animationFrameId = null;

// --- ELEMENTOS DOM ---
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const alertOverlay = document.getElementById('danger-alert');

// Modais
const calibModal = document.getElementById('calibration-modal');
const tutorialModal = document.getElementById('tutorial-modal');
const btnFabCalibrate = document.getElementById('btn-fab-calibrate');
const btnTutorialOpen = document.getElementById('btn-tutorial-open');
const btnStartCalib = document.getElementById('btn-start-calib');
const calibText = document.getElementById('calib-instruction');
const calibProgress = document.getElementById('calib-progress');

// --- SISTEMAS ---
const audioMgr = new AudioManager('./alert.mp3');
let detector = null;
let faceMesh = null;
let tickerWorker = null; 
let isProcessingFrame = false; 

// PERFIL ELEMENTS
const btnOpenProfile = document.getElementById('btn-open-profile');
const profileModal = document.getElementById('profile-modal');
const closeProfile = document.getElementById('close-profile');
const formProfile = document.getElementById('form-profile-update');
const profileNameInput = document.getElementById('profile-name-input');
const profilePhotoInput = document.getElementById('profile-photo-input');
const profileEmailReadonly = document.getElementById('profile-email-readonly');
const profilePreviewImg = document.getElementById('profile-preview-img');

// --- ELEMENTOS LGPD ---
const lgpdModal = document.getElementById('lgpd-modal');
const btnLgpdAccept = document.getElementById('btn-lgpd-accept');

// Verifica se existe token na URL ao carregar
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('convite');

if (inviteToken) {
    console.log("🎟️ Token de convite detectado:", inviteToken);
    // Opcional: Salvar em sessionStorage caso o login do Google limpe a URL
    sessionStorage.setItem('sd_invite_token', inviteToken);
}

// --- AUTH ---
document.getElementById('btn-google-login').addEventListener('click', () => {
    auth.signInWithPopup(googleProvider).catch((error) => {
        console.error("Erro Auth:", error);
        alert("Erro no login: " + error.message);
    });
});

document.getElementById('btn-logout').addEventListener('click', () => {
    stopSystem();
    auth.signOut();
});

// --- FLUXO DE AUTENTICAÇÃO  ---
auth.onAuthStateChanged(async (user) => {
    if (user) {
        // Usuário logou no Google. Agora o sistema valida a entrada.
        
        try {
            const userRef = db.collection('users').doc(user.uid);
            const doc = await userRef.get();
            
            let userRole = 'VIGIA'; 
            let userData = null;

            // --- CENÁRIO 1: USUÁRIO JÁ TEM CONTA ---
            if (doc.exists) {
                userData = doc.data();
                
                // 1. Verifica se foi banido/desativado
                if (userData.active === false) {
                    throw new Error("⛔ CONTA DESATIVADA: Contacte o administrador.");
                }

                // 2. CORREÇÃO DE NOMES
                // Atualiza o perfil no banco com os dados mais recentes do Google
                await userRef.set({
                    displayName: user.displayName,
                    email: user.email,
                    photoURL: user.photoURL,
                    lastLogin: new Date()
                }, { merge: true }); // 'merge: true' mantem a calibração salva

                userRole = userData.role;
                console.log(`✅ Acesso Permitido: ${userRole}`);
            } 
            
            // --- CENÁRIO 2: NOVO USUÁRIO ---
            else {
                console.log("👤 Novo visitante. Verificando convite...");
                
                // Busca token na URL ou na Memória
                const tokenToUse = inviteToken || sessionStorage.getItem('sd_invite_token');

                if (!tokenToUse) {
                    throw new Error("⛔ CADASTRO BLOQUEADO: Você precisa de um Link de Convite oficial para entrar.");
                }

                // Valida se o convite existe no banco
                const inviteRef = db.collection('invites').doc(tokenToUse);
                const inviteDoc = await inviteRef.get();

                if (!inviteDoc.exists) {
                    throw new Error("⛔ Convite inválido ou inexistente.");
                }

                const inviteData = inviteDoc.data();
                const now = new Date();
                const expiresAt = inviteData.expiresAt.toDate(); 

                // Valida as regras do convite
                if (!inviteData.active) throw new Error("⛔ Este convite foi cancelado.");
                if (inviteData.usesLeft <= 0) throw new Error("⛔ Este convite já atingiu o limite de usos.");
                if (expiresAt < now) throw new Error("⛔ Este convite expirou.");

                // --- TUDO CERTO: CRIA A CONTA ---
                console.log(`🎉 Convite aceito! Criando conta de ${inviteData.role}...`);
                userRole = inviteData.role;

                // Salva o novo usuário
                const newUserPayload = {
                    displayName: user.displayName,
                    email: user.email,
                    photoURL: user.photoURL,
                    role: userRole,
                    createdAt: now,
                    active: true,
                    invitedBy: inviteData.createdBy,
                    inviteUsed: tokenToUse,
                    lastLogin: now,
                    lgpdAccepted: false // Novo usuário ainda não aceitou
                };
                
                await userRef.set(newUserPayload);
                userData = newUserPayload;

                // Queima um uso do convite
                await inviteRef.update({
                    usesLeft: firebase.firestore.FieldValue.increment(-1)
                });
                
                sessionStorage.removeItem('sd_invite_token'); // Limpa para não reusar
            }

            // === LÓGICA LGPD ===
            // Verifica se o usuário já aceitou os termos
            if (!userData.lgpdAccepted) {
                console.log("🔒 LGPD: Consentimento pendente.");
                
                // 1. Mostra o Modal LGPD
                lgpdModal.classList.remove('hidden');
                setTimeout(() => lgpdModal.style.opacity = '1', 10);
                
                // 2. Esconde o login mas NÃO mostra o App ainda
                loginView.classList.add('hidden');
                
                // 3. Configura os botões do modal para destravar o fluxo
                setupLgpdEvents(user.uid);
                
                return;
            }

            // Se chegou aqui, já tem aceite LGPD. Inicia o App normalmente.
            startAppFlow(user, userRole, userData);

        } catch (error) {
            console.error("❌ ACESSO NEGADO:", error.message);
            alert(error.message);
            auth.signOut();
            
            appView.classList.remove('active');
            appView.classList.add('hidden');
            loginView.classList.remove('hidden');
            setTimeout(() => loginView.classList.add('active'), 100);
            stopSystem();
            
            // Garante que modal LGPD suma no erro
            lgpdModal.style.opacity = '0';
            setTimeout(() => lgpdModal.classList.add('hidden'), 300);
        }
        
    } else {
        // Estado deslogado padrão
        appView.classList.remove('active');
        appView.classList.add('hidden');
        loginView.classList.remove('hidden');
        setTimeout(() => loginView.classList.add('active'), 100);
        
        // Garante que modal LGPD suma no logout
        lgpdModal.style.opacity = '0';
        setTimeout(() => lgpdModal.classList.add('hidden'), 300);
        
        stopSystem();
    }
});

// --- FUNÇÕES AUXILIARES LGPD ---

function setupLgpdEvents(uid) {
    // Botão Aceitar
    btnLgpdAccept.onclick = async () => {
        const btn = btnLgpdAccept;
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = "Salvando...";

        try {
            // Salva no Firestore
            await db.collection('users').doc(uid).update({
                lgpdAccepted: true,
                lgpdAcceptedAt: new Date(),
                lgpdVersion: '1.0'
            });

            // Fecha Modal
            lgpdModal.style.opacity = '0';
            setTimeout(() => lgpdModal.classList.add('hidden'), 300);

            // Recarrega a página para pegar o fluxo limpo ou chama a função de inicio
            const userDoc = await db.collection('users').doc(uid).get();
            const userData = userDoc.data();
            startAppFlow(auth.currentUser, userData.role, userData);

        } catch (error) {
            console.error("Erro ao salvar LGPD:", error);
            alert("Erro ao salvar consentimento. Tente novamente.");
            btn.disabled = false;
            btn.innerText = originalText;
        }
    };
    // Botão Recusar removido
}

// Função para iniciar o app (isolada para ser chamada no login direto OU após aceite LGPD)
function startAppFlow(user, userRole, userData) {
    // UI Pós-Login
    loginView.classList.remove('active');
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    setTimeout(() => appView.classList.add('active'), 100);

    document.getElementById('user-name').innerText = user.displayName;
    document.getElementById('user-photo').src = user.photoURL;
    
    const roleSel = document.getElementById('role-selector');
    const roleDisp = document.getElementById('user-role-display');
    if (roleSel) roleSel.value = userRole;
    if (roleDisp) roleDisp.innerText = userRole;

    // Inicia Sistema
    initSystem(); 
    if (detector) detector.setRole(userRole);

    // Carrega calibração
    if (userData && userData.calibration && detector) {
        console.log("☁️ Calibração carregada.");
        const calib = userData.calibration;
        if (calib.EAR_THRESHOLD) detector.config.EAR_THRESHOLD = calib.EAR_THRESHOLD;
        if (calib.MAR_THRESHOLD) detector.config.MAR_THRESHOLD = calib.MAR_THRESHOLD;
        if (calib.HEAD_RATIO_THRESHOLD) detector.config.HEAD_RATIO_THRESHOLD = calib.HEAD_RATIO_THRESHOLD;
        detector.state.isCalibrated = true;
    } else {
        toggleModal(calibModal, true);
    }
}

// --- HELPER MODAL ---
function toggleModal(modal, show) {
    if (show) {
        modal.classList.remove('hidden');
        setTimeout(() => { modal.style.opacity = '1'; }, 10);
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.classList.add('hidden'), 300);
    }
}
document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => toggleModal(e.target.closest('.modal'), false));
});
window.addEventListener('click', (e) => {
    if (e.target === calibModal) toggleModal(calibModal, false);
    if (e.target === tutorialModal) toggleModal(tutorialModal, false);
});
btnFabCalibrate.addEventListener('click', () => toggleModal(calibModal, true));
btnTutorialOpen.addEventListener('click', () => {
    currentStep = 1; updateWizard(1); toggleModal(tutorialModal, true);
});
const roleSelector = document.getElementById('role-selector');
if(roleSelector) {
    roleSelector.addEventListener('change', (e) => {
        if (detector) {
            detector.setRole(e.target.value);
            document.getElementById('user-role-display').innerText = e.target.value;
            if (auth.currentUser) {
                db.collection('users').doc(auth.currentUser.uid).set({ role: e.target.value }, { merge: true });
            }
        }
    });
}

// --- INIT SYSTEM ---
async function initSystem() {
    if (detector) return;

    detector = new DrowsinessDetector(audioMgr, () => {}); 
    detector.state.monitoring = true;
    detector.updateUI("INICIANDO CÂMERA...");

    faceMesh = new FaceMesh({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`});
    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    faceMesh.onResults(onResults);

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
        });
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
            videoElement.play();
            startDetectionLoop(); 
            detector.updateUI("SISTEMA ATIVO"); // Feedback visual
        };
    } catch (err) {
        console.error("Erro Câmera:", err);
        alert("Erro ao abrir câmera: " + err.message);
    }
}

const debugSlider = document.getElementById('debug-slider');
const debugThreshVal = document.getElementById('debug-thresh-val');

if (debugSlider) {
    debugSlider.addEventListener('input', (e) => {
        const newVal = parseFloat(e.target.value);
        
        if (detector) {
            // Atualiza a config em tempo real
            detector.config.HEAD_RATIO_THRESHOLD = newVal;
            
            // Log para você saber o valor exato
            console.clear(); // Limpa para não poluir
            console.log(`🎚️ AJUSTE MANUAL: Novo Limite = ${newVal}`);
            console.log(`ℹ️ Dica: Se a leitura atual cair ABAIXO de ${newVal}, o alarme dispara.`);
        }
        
        debugThreshVal.innerText = newVal.toFixed(2);
    });
}

function stopSystem() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    if (tickerWorker) { 
        tickerWorker.terminate(); 
        tickerWorker = null; 
    }

    if (videoElement.srcObject) {
        videoElement.srcObject.getTracks().forEach(track => track.stop());
        videoElement.srcObject = null;
    }
}

let currentPitch = 0;

// --- LOOP PROCESSAMENTO ---
function onResults(results) {
    // 1. Limpa o canvas
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    
    if (!document.hidden) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        
        // Espelhamento (Mirror)
        canvasCtx.translate(canvasElement.width, 0);
        canvasCtx.scale(-1, 1);
        
        // --- AQUI ESTÁ A MÁGICA ---
        // Só desenha a foto da câmera se a variável for true
        if (window.showCameraFeed) {
            canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
        }
        // --------------------------
    }

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // --- DESENHO DA MÁSCARA (VISUAL UPGRADE) ---
        if (!document.hidden) {
            if (window.showCameraFeed) {
                // MODO CÂMERA LIGADA:
                // Mantemos simples (apenas contornos) para não atrapalhar a visão do rosto real
                drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#FFD028', lineWidth: 1.5});
            
            } else {
                // MODO CÂMERA DESLIGADA (HOLOGRÁFICO):
                // Aqui desenhamos o modelo 3D completo e detalhado
                
                // 1. A Malha "Wireframe" (Triângulos) - Ciano Tecnológico bem suave
                drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(0, 255, 255, 0.15)', lineWidth: 1});

                // 2. Contorno do Rosto - Branco/Cinza
                drawConnectors(canvasCtx, landmarks, FACEMESH_FACE_OVAL, {color: 'rgba(255,255,255,0.5)', lineWidth: 2});

                // 3. Destaque nos Olhos e Sobrancelhas (Foco da IA) - Seu Amarelo Marca
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYE, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYE, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYEBROW, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYEBROW, {color: '#FFD028', lineWidth: 2});

                // 4. Boca - Um tom avermelhado/laranja para diferenciar
                drawConnectors(canvasCtx, landmarks, FACEMESH_LIPS, {color: '#FF453A', lineWidth: 2});
                
                // 5. Íris (Pontos focais)
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_IRIS, {color: '#32D74B', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_IRIS, {color: '#32D74B', lineWidth: 2});
            }
        }
        
        // Cálculos Matemáticos (Isso é leve, pode rodar a cada frame)
        currentLeftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        currentRightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);
        currentMAR = calculateMAR(landmarks);
        currentHeadRatio = calculateHeadTilt(landmarks); 
        currentPitch = calculatePitchRatio(landmarks); // Seu novo cálculo

        // Envia para a lógica de detecção
        if (detector) {
            detector.processDetection(currentLeftEAR, currentRightEAR, currentMAR);
            detector.processHeadTilt(currentHeadRatio, currentPitch);
        }

        // --- OTIMIZAÇÃO DE UI (THROTTLE) ---
        // Só atualiza os textos e slider se passou 200ms (5 FPS de UI)
        const now = Date.now();
        if (now - lastUiUpdate > 200) {
            lastUiUpdate = now;

            const debugLive = document.getElementById('debug-live-val');
            const debugState = document.getElementById('debug-state');
            const slider = document.getElementById('debug-slider');

            if (debugLive && detector) {
                debugLive.innerText = currentHeadRatio.toFixed(3);
                
                // Só atualiza o slider se o usuário NÃO estiver arrastando ele
                if (document.activeElement !== slider) {
                     // Verifica se o valor mudou antes de forçar update do DOM (evita Reflow)
                     const currentThresh = detector.config.HEAD_RATIO_THRESHOLD;
                     if (Math.abs(parseFloat(slider.value) - currentThresh) > 0.01) {
                        slider.value = currentThresh;
                        document.getElementById('debug-thresh-val').innerText = currentThresh.toFixed(2);
                     }
                }

                // Lógica Visual
                const isRatioLow = currentHeadRatio < detector.config.HEAD_RATIO_THRESHOLD;
                const isLookingUp = currentPitch > 2.0;

                if (isLookingUp) {
                    debugState.innerText = "BLOQUEIO: OLHANDO CIMA ⬆️";
                    debugState.style.color = "var(--primary)";
                } else if (isRatioLow) {
                    debugState.innerText = "DETECTADO: BAIXO ⬇️";
                    debugState.style.color = "var(--danger)";
                } else {
                    debugState.innerText = "ESTADO: NORMAL ✅";
                    debugState.style.color = "var(--safe)";
                }
            }
        }
    } else {
        if (detector && detector.state.isCalibrated) detector.updateUI("ROSTO NÃO DETECTADO");
    }
    
    if (!document.hidden) canvasCtx.restore(); 
}

function updateDashboardUI(status) {} 

// --- CALIBRAÇÃO LÓGICA ---
let currentStep = 1;
const totalSteps = 3;
const wizardSteps = document.querySelectorAll('.wizard-step');
const dots = document.querySelectorAll('.dot');
const btnNext = document.getElementById('btn-next-step');
const btnPrev = document.getElementById('btn-prev-step');

function updateWizard(step) {
    wizardSteps.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    const activeStep = document.querySelector(`.wizard-step[data-step="${step}"]`);
    const activeDot = document.querySelector(`.dot[data-index="${step}"]`);
    if(activeStep) activeStep.classList.add('active');
    if(activeDot) activeDot.classList.add('active');
    
    if (step === 1) { btnPrev.style.opacity = '0'; btnPrev.style.pointerEvents = 'none'; }
    else { btnPrev.style.opacity = '1'; btnPrev.style.pointerEvents = 'all'; }
    btnNext.innerHTML = step === totalSteps ? 'Começar <span class="material-icons-round">check</span>' : 'Próximo';
}

if(btnNext) btnNext.addEventListener('click', () => {
    if (currentStep < totalSteps) { currentStep++; updateWizard(currentStep); }
    else { toggleModal(tutorialModal, false); }
});
if(btnPrev) btnPrev.addEventListener('click', () => {
    if (currentStep > 1) { currentStep--; updateWizard(currentStep); }
});

btnStartCalib.addEventListener('click', async () => {
    audioMgr.audioContext.resume();
    btnStartCalib.disabled = true;
    
    // Variáveis locais para armazenar as médias
    let avgOpenEAR = 0;
    let avgClosedEAR = 0;
    let avgYawnMAR = 0;
    let avgHeadRatio = 0; // Nova variável para cabeça

    // PASSO 1: OLHOS ABERTOS + POSTURA NEUTRA
    calibText.innerText = "Mantenha os olhos ABERTOS e a CABEÇA RETA...";
    calibProgress.style.width = "10%";
    await new Promise(r => setTimeout(r, 1500)); 
    
    // Coleta amostras
    avgOpenEAR = (currentLeftEAR + currentRightEAR) / 2;
    // *** NOVO: Captura a posição natural da cabeça ***
    avgHeadRatio = currentHeadRatio; 
    
    console.log("Calibração - Passo 1 (Neutro):", { avgOpenEAR, avgHeadRatio });

    calibProgress.style.width = "30%";
    await new Promise(r => setTimeout(r, 2000));

    // PASSO 2: OLHOS FECHADOS
    calibText.innerText = "Agora FECHE os olhos...";
    calibProgress.style.width = "50%";
    await new Promise(r => setTimeout(r, 2500));
    avgClosedEAR = (currentLeftEAR + currentRightEAR) / 2;

    // PASSO 3: BOCEJO (ABRIR BOCA)
    calibText.innerText = "Agora ABRA A BOCA (Simule um bocejo)...";
    calibProgress.style.width = "75%";
    await new Promise(r => setTimeout(r, 2500));
    avgYawnMAR = currentMAR;

    // FINALIZAÇÃO
    // Envia TODOS os 4 parâmetros para o detector (incluindo avgHeadRatio)
    if(detector) {
        detector.setCalibration(avgClosedEAR, avgOpenEAR, avgYawnMAR, avgHeadRatio);
    }
    
    calibText.innerText = "Calibração Concluída!";
    calibProgress.style.width = "100%";
    
    setTimeout(() => {
        toggleModal(calibModal, false);
        btnStartCalib.disabled = false;
        calibText.innerText = "Sente-se confortavelmente e olhe para frente.";
        calibProgress.style.width = "0%";
    }, 1000);
});

// --- LÓGICA DO ALMOÇO (1x POR DIA + LOGS + LOCK SCREEN) ---
const btnLunch = document.getElementById('btn-fab-lunch');
const lunchModal = document.getElementById('lunch-modal');
const btnLunchConfirm = document.getElementById('btn-confirm-lunch');
const btnLunchCancel = document.getElementById('btn-cancel-lunch');
const appContainer = document.getElementById('app-view'); // Para aplicar o blur

let isLunching = false;
const LUNCH_KEY = 'sundrowsy_last_lunch';

// Helper: Log no Firebase
function logLunchAction(actionType) {
    if (!auth.currentUser) return;
    
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
            type: actionType, // "LUNCH_START" ou "LUNCH_END"
            description: actionType === "LUNCH_START" ? "Início de Pausa Alimentar" : "Retorno de Pausa Alimentar",
            role: detector ? detector.config.role : 'DESCONHECIDO'
        })
        .then(() => console.log(`📝 Log de Almoço (${actionType}) salvo.`))
        .catch(e => console.error("❌ Erro ao salvar log:", e));
}

// Verifica data
function hasLunchToday() {
    const lastLunch = localStorage.getItem(LUNCH_KEY);
    const today = new Date().toDateString(); 
    return lastLunch === today;
}

async function startDetectionLoop() {
    if (!videoElement.videoWidth || videoElement.paused || videoElement.ended) {
        animationFrameId = requestAnimationFrame(startDetectionLoop);
        return;
    }

    if (!isProcessingFrame) {
        isProcessingFrame = true;
        try {
            await faceMesh.send({image: videoElement});
        } catch (error) {
            console.warn("Frame drop:", error);
        } finally {
            isProcessingFrame = false;
        }
    }
    animationFrameId = requestAnimationFrame(startDetectionLoop);
}

// Controla o Estado
function toggleLunchState(active) {
    if (!detector) return;
    
    isLunching = active;
    detector.state.monitoring = !active;

    if (active) {
        // --- INICIANDO ALMOÇO ---
        detector.stopAlarm();
        detector.updateUI("PAUSA: ALMOÇO 🍔");
        
        appContainer.classList.add('lunch-mode');
        
        if(btnLunch) btnLunch.classList.add('active');
        localStorage.setItem(LUNCH_KEY, new Date().toDateString());
        
        logLunchAction("LUNCH_START");
        console.log("🍔 Almoço INICIADO. Tela travada.");

    } else {
        // --- FINALIZANDO ALMOÇO ---
        detector.updateUI("ATIVO");
        
        appContainer.classList.remove('lunch-mode');

        if(btnLunch) {
            btnLunch.classList.remove('active');
            btnLunch.disabled = true;
            btnLunch.style.opacity = "0.5";
            btnLunch.style.filter = "grayscale(1)";
        }
        
        logLunchAction("LUNCH_END");
        console.log("▶️ Almoço FINALIZADO. Sistema retomado.");
    }
}

// Click Listener
if (btnLunch) {
    if (hasLunchToday()) {
        btnLunch.disabled = true;
        btnLunch.style.opacity = "0.5";
        btnLunch.style.filter = "grayscale(1)";
    }

    btnLunch.addEventListener('click', () => {
        if (isLunching) {
            toggleLunchState(false);
            return;
        }

        if (hasLunchToday()) {
            alert("⛔ Pausa já utilizada hoje!");
            return;
        }

        toggleModal(lunchModal, true);
    });
}

// Modais
if (btnLunchConfirm) {
    btnLunchConfirm.addEventListener('click', () => {
        toggleLunchState(true);
        toggleModal(lunchModal, false);
    });
}
if (btnLunchCancel) {
    btnLunchCancel.addEventListener('click', () => {
        toggleModal(lunchModal, false);
    });
}

// Debug Terminal
window.resetLunch = function() {
    console.clear();
    console.log("🛠️ RESETANDO LÓGICA DE ALMOÇO...");
    isLunching = false;
    localStorage.removeItem(LUNCH_KEY);
    
    if(appContainer) appContainer.classList.remove('lunch-mode');
    
    if (detector) {
        detector.state.monitoring = true;
        detector.updateUI("ATIVO (Resetado)");
    }
    if (btnLunch) {
        btnLunch.classList.remove('active');
        btnLunch.disabled = false;
        btnLunch.style.opacity = "1";
        btnLunch.style.filter = "none";
    }
    if (lunchModal) toggleModal(lunchModal, false);
    console.log("✅ Reset concluído.");
};

// --- LÓGICA DE PERFIL (CLIENTE) ---

// 1. Abrir Modal
if(btnOpenProfile) {
    btnOpenProfile.addEventListener('click', () => {
        const user = auth.currentUser;
        if(!user) return;

        profileNameInput.value = user.displayName || '';
        profilePhotoInput.value = user.photoURL || '';
        profileEmailReadonly.value = user.email || '';
        profilePreviewImg.src = user.photoURL || 'https://ui-avatars.com/api/?background=333&color=fff';

        toggleModal(profileModal, true);
    });
}

// 2. Preview em Tempo Real da Imagem
if(profilePhotoInput) {
    profilePhotoInput.addEventListener('input', (e) => {
        const url = e.target.value;
        if(url && url.length > 10) {
            profilePreviewImg.src = url;
        } else {
            if(auth.currentUser) profilePreviewImg.src = auth.currentUser.photoURL;
        }
    });
    profilePreviewImg.addEventListener('error', () => {
        profilePreviewImg.src = 'https://ui-avatars.com/api/?background=333&color=fff&name=ERROR';
    });
}

// 3. Salvar Perfil
if(formProfile) {
    formProfile.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = formProfile.querySelector('button');
        const originalText = btn.innerText;
        
        try {
            btn.disabled = true;
            btn.innerText = "Salvando...";
            
            const newName = profileNameInput.value;
            const newPhoto = profilePhotoInput.value;

            await auth.currentUser.updateProfile({
                displayName: newName,
                photoURL: newPhoto
            });

            await db.collection('users').doc(auth.currentUser.uid).update({
                displayName: newName,
                photoURL: newPhoto
            });

            document.getElementById('user-name').innerText = newName;
            document.getElementById('user-photo').src = newPhoto;

            alert("Perfil atualizado com sucesso!");
            toggleModal(profileModal, false);

        } catch (error) {
            console.error("Erro ao atualizar perfil:", error);
            alert("Erro: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    });
}

// --- CONTROLE DE VISIBILIDADE DA CÂMERA (CONSOLE) ---
window.showCameraFeed = true; 
const btnFabCamera = document.getElementById('btn-fab-camera');

window.toggleCamera = function(forceState) {
    // 1. Define o novo estado
    if (typeof forceState === 'boolean') {
        window.showCameraFeed = forceState;
    } else {
        window.showCameraFeed = !window.showCameraFeed;
    }
    
    // 2. Atualiza o Botão Visualmente
    if (btnFabCamera) {
        const icon = btnFabCamera.querySelector('span');
        if (window.showCameraFeed) {
            // Modo Normal (Vídeo)
            icon.innerText = 'videocam';
            btnFabCamera.classList.remove('active');
            btnFabCamera.style.background = 'rgba(255,255,255,0.1)';
            btnFabCamera.style.color = '#fff';
        } else {
            // Modo Matrix (Só Malha)
            icon.innerText = 'texture'; // Ícone de malha/textura
            btnFabCamera.classList.add('active');
            // Estilo Cyberpunk no botão
            btnFabCamera.style.background = 'rgba(0, 255, 255, 0.2)';
            btnFabCamera.style.color = 'cyan';
            btnFabCamera.style.boxShadow = '0 0 15px rgba(0, 255, 255, 0.4)';
        }
    }
    
    console.log(window.showCameraFeed ? "📷 CÂMERA: LIGADA" : "💀 MODO HOLOGRÁFICO ATIVO");
};

// Listener do Clique
if (btnFabCamera) {
    btnFabCamera.addEventListener('click', () => {
        window.toggleCamera(); // Alterna entre os modos
    });
}

// Fechar modal
if(closeProfile) {
    closeProfile.addEventListener('click', () => toggleModal(profileModal, false));
    window.addEventListener('click', (e) => {
        if (e.target === profileModal) toggleModal(profileModal, false);
    });
}