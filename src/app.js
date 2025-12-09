import { auth, googleProvider, db } from './firebase-config.js';
import { AudioManager } from './audio-manager.js';
import { DrowsinessDetector } from './detector.js'; 
import { LANDMARKS, calculateEAR, calculateMAR, calculateHeadTilt, calculatePitchRatio } from './vision-logic.js';
// Import da config nova
import { APP_CONFIG } from './config.js';

// --- VARIAVEIS GLOBAIS DE LEITURA INSTANTANEA ---
let currentLeftEAR = 0;
let currentRightEAR = 0;
let currentMAR = 0;
let currentHeadRatio = 0; 
let isCalibrating = false;

// CORREÇÃO BACKGROUND: Substitui o intervalId por um Worker
let detectionWorker = null;

let lastProcessTime = 0; // Controle de FPS

let lastUiUpdate = 0;

let hasPerformedCalibration = false;

// let animationFrameId = null; 
let detectionIntervalId = null;

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

// --- VARIÁVEIS DO GRÁFICO ---
const waveformCanvas = document.getElementById('ear-waveform');
const waveformCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;

// Array para guardar o histórico dos últimos 50 frames (EAR)
let earHistory = new Array(50).fill(0.3);

// Injeta a versão na UI assim que carrega
// Facilita saber qual versão o cliente tá rodando sem abrir console
(function injectVersion() {
    const footer = document.querySelector('.dev-footer');
    if (footer) {
        const verSpan = document.createElement('span');
        verSpan.style.display = 'block';
        verSpan.style.marginTop = '2px';
        verSpan.style.opacity = '0.3';
        verSpan.style.fontSize = '0.6rem';
        verSpan.style.fontFamily = 'monospace';
        verSpan.innerText = `v${APP_CONFIG.VERSION}`;
        footer.appendChild(verSpan);
    }
    console.log(`🚀 ${APP_CONFIG.NAME} carregado - Versão: ${APP_CONFIG.VERSION}`);
})();

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
    if (userData && userData.settings && typeof userData.settings.showCamera === 'boolean') {
        console.log(`⚙️ Preferência carregada: Câmera ${userData.settings.showCamera ? 'ON' : 'OFF'}`);
        // Força o estado salvo sem inverter
        window.toggleCamera(userData.settings.showCamera);
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
        // Reduzi para 640x480. 720p é overkill pra detecção e mata CPU sem placa de vídeo dedicada.
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
        });
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
            // FIX: Remove display:none e usa opacity 0 para garantir que o renderizador
            // processe os frames, permitindo que o drawImage do snapshot funcione.
            videoElement.style.display = 'block';
            videoElement.style.opacity = '0';
            videoElement.style.position = 'absolute';
            videoElement.style.zIndex = '-999';

            videoElement.play();
            startDetectionLoop();
            detector.updateUI("SISTEMA ATIVO");
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
            // Atualiza a config de OLHOS (EAR) em tempo real
            detector.config.EAR_THRESHOLD = newVal;
            
            console.clear();
            console.log(`👁️ AJUSTE MANUAL OLHOS: Novo Limite = ${newVal}`);
        }
        
        debugThreshVal.innerText = newVal.toFixed(2);
    });
}

function stopSystem() {
    // Mata o Worker
    if (detectionWorker) {
        detectionWorker.terminate();
        detectionWorker = null;
        console.log("🛑 Worker de detecção encerrado.");
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
        
        // Só desenha a foto da câmera se a variável for true
        if (window.showCameraFeed) {
            canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
        }
    }

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        // --- DESENHO DA MÁSCARA ---
        if (!document.hidden) {
            if (window.showCameraFeed) {
                // MODO CÂMERA LIGADA:
                drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#FFD028', lineWidth: 1.5});
            
            } else {
                // MODO HOLOGRÁFICO:
                drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: 'rgba(0, 255, 255, 0.15)', lineWidth: 1});
                drawConnectors(canvasCtx, landmarks, FACEMESH_FACE_OVAL, {color: 'rgba(255,255,255,0.5)', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYE, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYE, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_EYEBROW, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_EYEBROW, {color: '#FFD028', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LIPS, {color: '#FF453A', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_RIGHT_IRIS, {color: '#32D74B', lineWidth: 2});
                drawConnectors(canvasCtx, landmarks, FACEMESH_LEFT_IRIS, {color: '#32D74B', lineWidth: 2});
            }
        }
        
        // Cálculos Matemáticos
        currentLeftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        currentRightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);
        currentMAR = calculateMAR(landmarks);
        currentHeadRatio = calculateHeadTilt(landmarks); 
        currentPitch = calculatePitchRatio(landmarks); 

        // Média dos dois olhos
        const avgEAR = (currentLeftEAR + currentRightEAR) / 2;
        
        // Atualiza Gráfico (EAR Waveform)
        if(detector) updateWaveform(avgEAR, detector.config.EAR_THRESHOLD);

        // Envia para a lógica de detecção
        if (detector && !isCalibrating) {
            detector.processDetection(currentLeftEAR, currentRightEAR, currentMAR);
            detector.processHeadTilt(currentHeadRatio, currentPitch);
        }

        // --- OTIMIZAÇÃO DE UI (THROTTLE) ---
        const now = Date.now();
        if (now - lastUiUpdate > 200) {
            lastUiUpdate = now;

            const sliderEyes = document.getElementById('debug-slider-eyes');
            const sliderHead = document.getElementById('debug-slider-head');
            const debugState = document.getElementById('debug-state');

            if (detector) {
                // --- ATUALIZA PAINEL DE OLHOS ---
                const eyesLiveEl = document.getElementById('debug-live-val-eyes');
                const eyesThreshEl = document.getElementById('debug-thresh-val-eyes');
                
                if(eyesLiveEl) eyesLiveEl.innerText = avgEAR.toFixed(3);
                
                // Sincroniza Slider Olhos (se não estiver arrastando)
                if (document.activeElement !== sliderEyes) {
                     const currEarThresh = detector.config.EAR_THRESHOLD;
                     if (Math.abs(parseFloat(sliderEyes.value) - currEarThresh) > 0.01) {
                        sliderEyes.value = currEarThresh;
                        if(eyesThreshEl) eyesThreshEl.innerText = currEarThresh.toFixed(2);
                     }
                }

                // --- ATUALIZA PAINEL DE CABEÇA ---
                const headLiveEl = document.getElementById('debug-live-val-head');
                const headThreshEl = document.getElementById('debug-thresh-val-head');
                
                if(headLiveEl) headLiveEl.innerText = currentHeadRatio.toFixed(3);
                
                // Sincroniza Slider Cabeça (se não estiver arrastando)
                if (document.activeElement !== sliderHead) {
                     const currHeadThresh = detector.config.HEAD_RATIO_THRESHOLD;
                     if (Math.abs(parseFloat(sliderHead.value) - currHeadThresh) > 0.01) {
                        sliderHead.value = currHeadThresh;
                        if(headThreshEl) headThreshEl.innerText = currHeadThresh.toFixed(2);
                     }
                }

                // --- ESTADO GERAL (TEXTO) ---
                const isEyesClosed = avgEAR < detector.config.EAR_THRESHOLD;
                const isRatioLow = currentHeadRatio < detector.config.HEAD_RATIO_THRESHOLD;
                const isLookingUp = currentPitch > 2.0;

                if (isLookingUp) {
                    debugState.innerText = "BLOQUEIO: OLHANDO CIMA ⬆️";
                    debugState.style.color = "var(--primary)";
                } else if (isRatioLow) {
                    debugState.innerText = "DETECTADO: CABEÇA BAIXA ⬇️";
                    debugState.style.color = "var(--danger)";
                } else if (isEyesClosed) {
                    debugState.innerText = "DETECTADO: OLHOS FECHADOS 😴";
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
    // 1. Acorda o contexto de áudio
    if (audioMgr && audioMgr.audioContext) audioMgr.audioContext.resume();
    
    // --- BLOQUEIO DE SEGURANÇA ---
    isCalibrating = true;
    if (detector) detector.stopAlarm();
    detector.updateUI("CALIBRANDO..."); 
    // -----------------------------

    btnStartCalib.disabled = true;

    // Define se é a primeira vez ou recalibração (Speed Run)
    const isFirstTime = !hasPerformedCalibration;

    // Tempos Dinâmicos (Primeira vez vs Recalibração)
    // Intro: De 9s cai para 2.5s (Só pra preparar)
    const t_intro = isFirstTime ? 9000 : 2500;
    // Passos: Reduzidos quase pela metade
    const t_open = isFirstTime ? 7000 : 4000;
    const t_close = isFirstTime ? 9000 : 5000;
    const t_yawn = isFirstTime ? 8200 : 5000;
    const t_final = isFirstTime ? 4500 : 2000;

    // 2. SÓ TOCA O ÁUDIO SE FOR A PRIMEIRA VEZ
    if (isFirstTime) {
        const fullAudio = new Audio('assets/calibracao.mp3');
        fullAudio.volume = 1.0;
        fullAudio.play().catch(e => {
            console.error("Erro ao tocar áudio completo:", e);
        });
    } else {
        console.log("⏩ Modo Recalibração: Áudio pulado.");
    }

    // Variáveis de captura
    let avgOpenEAR = 0, avgClosedEAR = 0, avgYawnMAR = 0, avgHeadRatio = 0;

    // --- FASE 1: INTRODUÇÃO ---
    calibText.innerText = isFirstTime 
        ? "Bem-vindo. Sente-se confortavelmente e olhe para frente." 
        : "Preparando recalibração rápida..."; // Texto adaptado
    calibProgress.style.width = "10%";
    
    await new Promise(r => setTimeout(r, t_intro)); 

    // --- FASE 2: OLHOS ABERTOS ---
    calibText.innerText = "Mantenha os olhos ABERTOS e a CABEÇA RETA.";
    calibProgress.style.width = "30%";
    
    await new Promise(r => setTimeout(r, t_open));

    // CAPTURA NEUTRA
    avgOpenEAR = (currentLeftEAR + currentRightEAR) / 2;
    avgHeadRatio = currentHeadRatio;
    console.log("✅ Passo 1 (Neutro) Capturado");

    // --- FASE 3: OLHOS FECHADOS ---
    calibText.innerText = "Mantenha os olhos FECHADOS...";
    calibProgress.style.width = "60%";

    await new Promise(r => setTimeout(r, t_close));
    
    // CAPTURA FECHADO
    avgClosedEAR = (currentLeftEAR + currentRightEAR) / 2;
    console.log("✅ Passo 2 (Fechado) Capturado");

    // --- FASE 4: BOCEJO ---
    calibText.innerText = "ABRA A BOCA (Simule um bocejo)...";
    calibProgress.style.width = "85%";

    await new Promise(r => setTimeout(r, t_yawn));
    
    // CAPTURA BOCEJO
    avgYawnMAR = currentMAR;
    console.log("✅ Passo 3 (Bocejo) Capturado");

    // --- FASE 5: FINALIZAÇÃO ---
    if(detector) {
        detector.setCalibration(avgClosedEAR, avgOpenEAR, avgYawnMAR, avgHeadRatio);
    }
    
    calibText.innerText = "Calibração Atualizada!";
    calibProgress.style.width = "100%";
    
    await new Promise(r => setTimeout(r, t_final));
    
    // Fecha tudo e LIBERA O SISTEMA
    toggleModal(calibModal, false);
    btnStartCalib.disabled = false;
    calibText.innerText = "Sente-se confortavelmente e olhe para frente.";
    calibProgress.style.width = "0%";
    
    // --- LIBERA O DETECTOR ---
    isCalibrating = false;
    hasPerformedCalibration = true; // Marca que já fez uma vez nessa sessão
    if(detector) detector.updateUI("SISTEMA ATIVO");
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

const DETECTION_FPS = 20;

function startDetectionLoop() {
    if (detectionWorker) return; // Já tá rodando

    // Cria um script de Worker em tempo real (Blob)
    // Esse script roda numa thread separada que o Chrome não consegue "pausar" facilmente
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            if (e.data === "start") {
                // Roda a 20 FPS (50ms) cravado, sem choro do navegador
                setInterval(() => { postMessage("tick"); }, 50);
            }
        };
    `], { type: "text/javascript" });

    detectionWorker = new Worker(URL.createObjectURL(workerBlob));

    ddetectionWorker.onmessage = function(e) {
    if (e.data === "tick") {
        if (!isProcessingFrame && faceMesh && videoElement && !videoElement.paused && !document.hidden) { 
            // Adicionado: && !document.hidden
            isProcessingFrame = true;
            
            // Envia pro MediaPipe
            faceMesh.send({image: videoElement})
                .then(() => { isProcessingFrame = false; })
                .catch(() => { isProcessingFrame = false; });
        }
    }
};

    detectionWorker.postMessage("start");
    console.log("🚀 Worker de Background Iniciado (Anti-Throttle Ativo)");
}

function handleVisibilityChange() {
    if (!auth.currentUser || !detector) return;

    if (document.hidden) {
        // A ABA SAIU DO FOCO
        console.warn("😴 PÁGINA INATIVA: Reduzindo o impacto visual. O monitoramento CONTINUA.");
        
        // 1. O Worker CONTINUA a mandar 'tick', mas o check !document.hidden vai bloquear o faceMesh.send
        detector.state.monitoring = true; // Mantém ligado (para logs/eventos de alarme que já estavam ativos)

        // 2. PARE o alarme imediatamente (você já faz isso, ótimo)
        detector.stopAlarm(); 

        // 3. Atualiza UI/Console (apenas para debug/log)
        detector.updateUI("MONITORANDO: SEGUNDO PLANO");
        
    } else {
        // A ABA VOLTOU AO FOCO
        console.log("🚀 PÁGINA ATIVA: Retomando UI e monitoramento em foco.");
        detector.state.monitoring = true;
        
        // Garantir que o MediaPipe RECOMECE o processamento
        // O bloqueio do `faceMesh.send` já é suficiente. 
        // A única coisa a fazer é garantir que a UI se atualize.
        
        // Retoma o UI (se não houver alarme ativo)
        if (!detector.state.isAlarmActive) {
            detector.updateUI("SISTEMA ATIVO");
        }
    }
}

// O listener deve ser mantido:
document.addEventListener('visibilitychange', handleVisibilityChange);

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
    // 1. Define o novo estado (Se passar forceState, usa ele. Se não, inverte o atual)
    if (typeof forceState === 'boolean') {
        window.showCameraFeed = forceState;
    } else {
        window.showCameraFeed = !window.showCameraFeed;
    }
    
    // 2. Atualiza o Botão Visualmente
    if (btnFabCamera) {
        const icon = btnFabCamera.querySelector('span');
        if (window.showCameraFeed) {
            // Modo Normal (Vídeo normal)
            icon.innerText = 'videocam';
            btnFabCamera.classList.remove('active');
            btnFabCamera.style.background = 'rgba(255,255,255,0.1)';
            btnFabCamera.style.color = '#fff';
            btnFabCamera.style.boxShadow = 'none';
        } else {
            // Modo Matrix (Só a máscara)
            icon.innerText = 'texture'; 
            btnFabCamera.classList.add('active');
            btnFabCamera.style.background = 'rgba(0, 255, 255, 0.2)';
            btnFabCamera.style.color = 'cyan';
            btnFabCamera.style.boxShadow = '0 0 15px rgba(0, 255, 255, 0.4)';
        }
    }
    
    console.log(window.showCameraFeed ? "📷 CÂMERA: LIGADA" : "💀 MODO HOLOGRÁFICO ATIVO");

    // 3. Salva a preferência no Firebase
    // Só salva se não foi uma chamada de "carregamento"
    if (auth.currentUser) {
        db.collection('users').doc(auth.currentUser.uid).set({
            settings: { 
                showCamera: window.showCameraFeed 
            }
        }, { merge: true }).catch(err => console.error("Erro ao salvar pref. câmera:", err));
    }
};

// Gráfico do MAR da tela de Monitoramento 
function updateWaveform(currentEAR, threshold) {
    if (!waveformCtx) return;

    const width = waveformCanvas.width;
    const height = waveformCanvas.height;

    // 1. Atualiza Dados (Remove o antigo, põe o novo)
    earHistory.push(currentEAR);
    earHistory.shift();

    // 2. Limpa o Canvas
    waveformCtx.clearRect(0, 0, width, height);

    // 3. Desenha Linha de Limite (Vermelha)
    // Mapeia o threshold (ex: 0.22) para a altura do canvas (0 a 0.5 de range visual)
    const threshY = height - (threshold / 0.5) * height;
    
    waveformCtx.beginPath();
    waveformCtx.strokeStyle = 'rgba(255, 69, 58, 0.6)'; // Vermelho meio transparente
    waveformCtx.lineWidth = 1;
    waveformCtx.setLineDash([4, 4]); // Linha pontilhada
    waveformCtx.moveTo(0, threshY);
    waveformCtx.lineTo(width, threshY);
    waveformCtx.stroke();
    waveformCtx.setLineDash([]); // Reseta

    // 4. Desenha Onda do EAR (Amarela/Azul)
    waveformCtx.beginPath();
    waveformCtx.lineWidth = 2;
    // Se estiver abaixo do limite (perigo), a linha fica vermelha, senão amarela/azul
    waveformCtx.strokeStyle = currentEAR < threshold ? '#FF453A' : '#FFD028'; 
    waveformCtx.shadowBlur = 5;
    waveformCtx.shadowColor = waveformCtx.strokeStyle;

    // Percorre o histórico e desenha
    const step = width / (earHistory.length - 1);
    
    for (let i = 0; i < earHistory.length; i++) {
        const val = earHistory[i];
        // Mapeia valor (0.0 a 0.5) para altura do canvas
        // Clamp para não sair do gráfico visualmente
        const clampVal = Math.min(Math.max(val, 0), 0.5); 
        const y = height - (clampVal / 0.5) * height;
        
        if (i === 0) waveformCtx.moveTo(0, y);
        else waveformCtx.lineTo(i * step, y);
    }
    waveformCtx.stroke();
    
    // Reset de sombra para performance
    waveformCtx.shadowBlur = 0;
}

// --- FUNÇÃO PARA SALVAR NO FIREBASE ---
const saveCalibrationToFirebase = async () => {
    if (!auth.currentUser || !detector) return;

    console.log("💾 Salvando ajustes no perfil...");

    try {
        await db.collection('users').doc(auth.currentUser.uid).set({
            calibration: {
                // Pega os valores atuais que estão na memória do detector (já atualizados pelo slider)
                EAR_THRESHOLD: detector.config.EAR_THRESHOLD,
                HEAD_RATIO_THRESHOLD: detector.config.HEAD_RATIO_THRESHOLD,
                // Importante manter o MAR (boca) mesmo sem slider, pra não perder a calibração dele
                MAR_THRESHOLD: detector.config.MAR_THRESHOLD 
            }
        }, { merge: true }); // 'merge' garante que não apague outros dados do user
        
        console.log("✅ Ajustes sincronizados com sucesso.");
    } catch (error) {
        console.error("❌ Erro ao salvar ajustes:", error);
    }
};

// --- EVENT LISTENERS DOS SLIDERS ---

const debugSliderEyes = document.getElementById('debug-slider-eyes');
const debugThreshValEyes = document.getElementById('debug-thresh-val-eyes');

if (debugSliderEyes) {
    // Evento INPUT: Atualiza visual e lógica local em tempo real (sem gravar no banco)
    debugSliderEyes.addEventListener('input', (e) => {
        const newVal = parseFloat(e.target.value);
        if (detector) {
            detector.config.EAR_THRESHOLD = newVal;
        }
        if(debugThreshValEyes) debugThreshValEyes.innerText = newVal.toFixed(2);
    });

    // Evento CHANGE: Dispara SÓ quando solta o mouse/dedo -> Grava no Banco
    debugSliderEyes.addEventListener('change', saveCalibrationToFirebase);
}

const debugSliderHead = document.getElementById('debug-slider-head');
const debugThreshValHead = document.getElementById('debug-thresh-val-head');

if (debugSliderHead) {
    // Evento INPUT: Visual e Local
    debugSliderHead.addEventListener('input', (e) => {
        const newVal = parseFloat(e.target.value);
        if (detector) {
            detector.config.HEAD_RATIO_THRESHOLD = newVal;
        }
        if(debugThreshValHead) debugThreshValHead.innerText = newVal.toFixed(2);
    });

    // Evento CHANGE: Grava no Banco
    debugSliderHead.addEventListener('change', saveCalibrationToFirebase);
}

// Torna global pro Detector conseguir chamar
window.captureSnapshot = async () => {
    // Verifica se o elemento de vídeo existe e está carregado
    if (!videoElement) return null;

    // FIX: Se o vídeo não tiver dimensões (ex: display none), aborta para evitar erro ou imagem preta
    if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        console.warn("⚠️ Snapshot abortado: Vídeo sem dimensões detectadas (videoWidth=0).");
        return null;
    }

    // Retorna uma Promise que resolve com a string Base64 da imagem RAW
    return new Promise((resolve) => {
        // 1. Cria um canvas temporário em memória para a captura raw
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');

        // 2. Define o tamanho do canvas com base no vídeo
        tempCanvas.width = videoElement.videoWidth;
        tempCanvas.height = videoElement.videoHeight;

        // 3. Desenha o frame atual do vídeo (Raw) no canvas temporário
        // Aplica o espelhamento horizontal (mirror) para a imagem capturada
        tempCtx.save();
        tempCtx.translate(tempCanvas.width, 0);
        tempCtx.scale(-1, 1);
        tempCtx.drawImage(videoElement, 0, 0, tempCanvas.width, tempCanvas.height);
        tempCtx.restore();

        // 4. Converte a imagem raw para Base64 (qualidade 0.5 para otimizar o Firebase)
        const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.5);

        if (dataUrl && dataUrl.length > 100) {
            // Log para debug, mostrando o tamanho da imagem
            console.log("📸 Snapshot RAW capturado e convertido para Base64 (Tamanho: " + Math.round(dataUrl.length/1024) + "KB)");
            resolve(dataUrl);
        } else {
            console.warn("⚠️ Falha ao gerar snapshot RAW.");
            resolve(null);
        }
    });
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