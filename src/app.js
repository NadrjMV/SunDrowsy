import { auth, googleProvider, db } from './firebase-config.js';
import { AudioManager } from './audio-manager.js';
import { DrowsinessDetector } from './detector.js'; 
import { LANDMARKS, calculateEAR, calculateMAR, calculateHeadTilt } from './vision-logic.js';

// --- VARIAVEIS GLOBAIS DE LEITURA INSTANTANEA ---
let currentLeftEAR = 0;
let currentRightEAR = 0;
let currentMAR = 0; // Nova variável para guardar o valor da boca em tempo real

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
        // Usuário autenticado no Google. Verificando permissão de acesso no Firestore...
        
        try {
            const userRef = db.collection('users').doc(user.uid);
            const doc = await userRef.get();
            
            let userRole = 'VIGIA'; // Valor padrão de segurança
            let userData = null;

            // --- CENÁRIO A: USUÁRIO JÁ EXISTENTE ---
            if (doc.exists) {
                userData = doc.data();
                
                // Trava de segurança
                if (userData.active === false) {
                    throw new Error("⛔ Sua conta foi desativada pelo administrador.");
                }

                userRole = userData.role;
                console.log(`✅ Usuário reconhecido: ${userRole}. Acesso liberado.`);

                // >>> ADICIONE ESTE BLOCO AQUI PARA CORRIGIR OS NOMES <<<
                // Força atualização dos dados do Google para o Banco de Dados
                await userRef.set({
                    displayName: user.displayName,
                    email: user.email,
                    photoURL: user.photoURL,
                    lastLogin: new Date()
                }, { merge: true }); // 'merge: true' é vital para não apagar a calibração
            }
            
            // --- CENÁRIO B: NOVO USUÁRIO (NECESSITA CONVITE) ---
            else {
                console.log("👤 Novo usuário detectado. Buscando credencial de convite...");
                
                // Tenta recuperar token da URL ou do SessionStorage (caso o redirect do Google tenha limpado a URL)
                const tokenToUse = inviteToken || sessionStorage.getItem('sd_invite_token');

                if (!tokenToUse) {
                    throw new Error("⛔ CADASTRO BLOQUEADO: É necessário um link de convite válido para criar conta.");
                }

                // Valida o convite no banco de dados
                const inviteRef = db.collection('invites').doc(tokenToUse);
                const inviteDoc = await inviteRef.get();

                if (!inviteDoc.exists) {
                    throw new Error("⛔ O código do convite é inválido ou não existe.");
                }

                const inviteData = inviteDoc.data();
                const now = new Date();
                const expiresAt = inviteData.expiresAt.toDate(); // Converte Timestamp do Firestore para Date JS

                // Checagens rigorosas do convite
                if (!inviteData.active) throw new Error("⛔ Este convite foi revogado pelo administrador.");
                if (inviteData.usesLeft <= 0) throw new Error("⛔ O limite de usos deste convite foi atingido.");
                if (expiresAt < now) throw new Error("⛔ Este convite expirou.");

                // --- TUDO VÁLIDO: CRIA A CONTA ---
                console.log(`🎉 Convite Válido! Criando conta como ${inviteData.role}...`);
                userRole = inviteData.role;

                // 1. Cria o documento do usuário
                const newUserPayload = {
                    displayName: user.displayName || 'Usuário Sem Nome',
                    email: user.email,
                    photoURL: user.photoURL,
                    role: userRole,
                    createdAt: now,
                    active: true,
                    invitedBy: inviteData.createdBy,
                    inviteUsed: tokenToUse
                };
                
                await userRef.set(newUserPayload);
                userData = newUserPayload; // Atualiza variável local para uso imediato

                // 2. Decrementa o uso do convite (Atomicamente)
                await inviteRef.update({
                    usesLeft: firebase.firestore.FieldValue.increment(-1)
                });
                
                // Limpa o token usado da sessão para evitar reuso acidental
                sessionStorage.removeItem('sd_invite_token');
            }

            // --- LÓGICA DE UI PÓS-LOGIN (HAPPY PATH) ---
            
            // 1. Troca de telas
            loginView.classList.remove('active');
            loginView.classList.add('hidden');
            appView.classList.remove('hidden');
            setTimeout(() => appView.classList.add('active'), 100);

            // 2. Preenche dados do HUD
            document.getElementById('user-name').innerText = user.displayName;
            document.getElementById('user-photo').src = user.photoURL;
            
            // 3. Atualiza seletores e displays de função
            const roleSel = document.getElementById('role-selector');
            const roleDisp = document.getElementById('user-role-display');
            if (roleSel) roleSel.value = userRole;
            if (roleDisp) roleDisp.innerText = userRole;

            // 4. Inicializa o Sistema
            initSystem(); // Liga câmera e loop
            if (detector) detector.setRole(userRole);

            // 5. Carrega ou Solicita Calibração
            // Verifica se o usuário já tem calibração salva no banco
            if (userData && userData.calibration && detector) {
                console.log("☁️ [FIREBASE] Carregando calibração salva...");
                const calib = userData.calibration;
                
                // Aplica valores salvos
                if (calib.EAR_THRESHOLD) detector.config.EAR_THRESHOLD = calib.EAR_THRESHOLD;
                if (calib.MAR_THRESHOLD) detector.config.MAR_THRESHOLD = calib.MAR_THRESHOLD;
                if (calib.HEAD_RATIO_THRESHOLD) detector.config.HEAD_RATIO_THRESHOLD = calib.HEAD_RATIO_THRESHOLD;
                
                detector.state.isCalibrated = true;
                detector.updateUI("Calibração carregada. Monitorando...");
            } else {
                console.log("⚠️ [FIREBASE] Sem calibração salva. Solicitando ao usuário...");
                toggleModal(calibModal, true);
            }

        } catch (error) {
            console.error("❌ ERRO CRÍTICO DE ACESSO:", error);
            alert(error.message); // Feedback visual para o usuário
            
            // Desloga imediatamente para impedir acesso não autorizado
            auth.signOut(); 
            
            // Reseta UI para tela de login
            appView.classList.remove('active');
            appView.classList.add('hidden');
            loginView.classList.remove('hidden');
            setTimeout(() => loginView.classList.add('active'), 100);
            stopSystem();
        }
        
    } else {
        // --- USUÁRIO DESLOGADO ---
        console.log("🔒 Usuário desconectado.");
        appView.classList.remove('active');
        appView.classList.add('hidden');
        loginView.classList.remove('hidden');
        setTimeout(() => loginView.classList.add('active'), 100);
        stopSystem();
    }
});

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
            startBackgroundLoop();
        };
    } catch (err) {
        console.error("Erro Câmera:", err);
        alert("Erro ao abrir câmera: " + err.message);
    }
}

function startBackgroundLoop() {
    const blob = new Blob([`
        let interval = null;
        self.onmessage = function(e) {
            if (e.data === 'start') {
                interval = setInterval(() => postMessage('tick'), 33);
            } else if (e.data === 'stop') {
                clearInterval(interval);
            }
        };
    `], { type: 'application/javascript' });

    tickerWorker = new Worker(URL.createObjectURL(blob));
    tickerWorker.onmessage = async () => {
        if (isProcessingFrame || !videoElement.videoWidth) return;
        isProcessingFrame = true;
        try { await faceMesh.send({image: videoElement}); } catch (error) { }
        isProcessingFrame = false;
    };
    tickerWorker.postMessage('start');
    detector.updateUI("ATIVO");
}

function stopSystem() {
    if (tickerWorker) { tickerWorker.postMessage('stop'); tickerWorker.terminate(); tickerWorker = null; }
    if (videoElement.srcObject) { videoElement.srcObject.getTracks().forEach(track => track.stop()); }
}

// --- LOOP PROCESSAMENTO ---
function onResults(results) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    
    if (!document.hidden) {
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
        canvasCtx.translate(canvasElement.width, 0);
        canvasCtx.scale(-1, 1);
        canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    }

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];

        if (!document.hidden) {
            drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#FFD028', lineWidth: 1.5});
        }
        
        // Calcula EAR e MAR
        currentLeftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        currentRightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);
        currentMAR = calculateMAR(landmarks);

        // *** NOVO: Calcula inclinação da cabeça ***
        const headTiltData = calculateHeadTilt(landmarks);

        if (detector) {
            // Processa detecção de olhos e boca
            detector.processDetection(currentLeftEAR, currentRightEAR, currentMAR);
            
            // *** NOVO: Processa detecção de cabeça baixa ***
            detector.processHeadTilt(headTiltData);
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

    // PASSO 1: OLHOS ABERTOS (Referência Neutra)
    calibText.innerText = "Mantenha os olhos ABERTOS e boca FECHADA...";
    calibProgress.style.width = "10%";
    await new Promise(r => setTimeout(r, 1000)); // Estabilizar
    
    // Coleta rápida de amostras
    avgOpenEAR = (currentLeftEAR + currentRightEAR) / 2;
    calibProgress.style.width = "30%";
    await new Promise(r => setTimeout(r, 2000));

    // PASSO 2: OLHOS FECHADOS
    calibText.innerText = "Agora FECHE os olhos...";
    calibProgress.style.width = "50%";
    await new Promise(r => setTimeout(r, 2500));
    avgClosedEAR = (currentLeftEAR + currentRightEAR) / 2; // Pega o valor do momento (fechado)

    // PASSO 3: BOCEJO (ABRIR BOCA)
    calibText.innerText = "Agora ABRA A BOCA (Simule um bocejo)...";
    calibProgress.style.width = "75%";
    await new Promise(r => setTimeout(r, 2500));
    avgYawnMAR = currentMAR; // Pega o valor máximo de abertura

    // FINALIZAÇÃO
    calibText.innerText = "Calibração Concluída!";
    calibProgress.style.width = "100%";
    
    // Envia tudo pro detector (Open EAR, Closed EAR, Open MAR)
    if(detector) detector.setCalibration(avgClosedEAR, avgOpenEAR, avgYawnMAR); 

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
    
    // Salva na mesma estrutura dos alarmes: logs/UID/DATA/evento
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

// Controla o Estado
function toggleLunchState(active) {
    if (!detector) return;
    
    isLunching = active;
    detector.state.monitoring = !active;

    if (active) {
        // --- INICIANDO ALMOÇO ---
        detector.stopAlarm();
        detector.updateUI("PAUSA: ALMOÇO 🍔");
        
        // CSS: Trava a tela
        appContainer.classList.add('lunch-mode');
        
        // Lógica
        if(btnLunch) btnLunch.classList.add('active');
        localStorage.setItem(LUNCH_KEY, new Date().toDateString());
        
        // Log
        logLunchAction("LUNCH_START");
        console.log("🍔 Almoço INICIADO. Tela travada.");

    } else {
        // --- FINALIZANDO ALMOÇO ---
        detector.updateUI("ATIVO");
        
        // CSS: Destrava a tela
        appContainer.classList.remove('lunch-mode');

        if(btnLunch) {
            btnLunch.classList.remove('active');
            // Bloqueia visualmente o botão pois já usou a cota do dia
            btnLunch.disabled = true;
            btnLunch.style.opacity = "0.5";
            btnLunch.style.filter = "grayscale(1)";
        }
        
        // Log
        logLunchAction("LUNCH_END");
        console.log("▶️ Almoço FINALIZADO. Sistema retomado.");
    }
}

// Click Listener
if (btnLunch) {
    // Checa estado inicial ao carregar a página
    if (hasLunchToday()) {
        btnLunch.disabled = true;
        btnLunch.style.opacity = "0.5";
        btnLunch.style.filter = "grayscale(1)";
    }

    btnLunch.addEventListener('click', () => {
        // 1. Se já está almoçando, o clique serve para VOLTAR (destravar tela)
        if (isLunching) {
            toggleLunchState(false);
            return;
        }

        // 2. Se não está almoçando, verifica bloqueio
        if (hasLunchToday()) {
            alert("⛔ Pausa já utilizada hoje!");
            return;
        }

        // 3. Abre confirmação
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
    
    // Remove trava visual
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