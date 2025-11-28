import { auth, googleProvider, db } from './firebase-config.js';
import { AudioManager } from './audio-manager.js';
import { DrowsinessDetector } from './detector.js'; 
import { LANDMARKS, calculateEAR } from './vision-logic.js';

// --- ELEMENTOS DOM ---
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const alertOverlay = document.getElementById('danger-alert');

// Modais e Botões
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
let camera = null;

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

auth.onAuthStateChanged(async (user) => {
    if (user) {
        // Transição de Login
        loginView.classList.remove('active');
        loginView.classList.add('hidden');
        appView.classList.remove('hidden');
        setTimeout(() => appView.classList.add('active'), 100);

        document.getElementById('user-name').innerText = user.displayName;
        document.getElementById('user-photo').src = user.photoURL;
        
        initSystem();
        
        // Carrega Dados do Usuário (Role + Calibração)
        try {
            const doc = await db.collection('users').doc(user.uid).get();
            let userRole = 'MOTORISTA'; 

            if(doc.exists) {
                // Define Role (Motorista/Vigia)
                if(doc.data().role) userRole = doc.data().role;
                
                // Define Calibração
                if(doc.data().calibration && detector) {
                    detector.config = { ...detector.config, ...doc.data().calibration };
                    detector.state.isCalibrated = true;
                    console.log("Calibração carregada.");
                } else {
                    toggleModal(calibModal, true);
                }
            } else {
                toggleModal(calibModal, true);
            }
            
            // Sincroniza Interface e Detector
            if(detector) detector.setRole(userRole);
            const roleSel = document.getElementById('role-selector');
            const roleDisp = document.getElementById('user-role-display');
            
            if(roleSel) roleSel.value = userRole;
            if(roleDisp) roleDisp.innerText = userRole;

        } catch (e) {
            console.log("Erro ao carregar dados:", e);
            toggleModal(calibModal, true);
        }
        
    } else {
        // Logout
        appView.classList.remove('active');
        appView.classList.add('hidden');
        loginView.classList.remove('hidden');
        setTimeout(() => loginView.classList.add('active'), 100);
        stopSystem();
    }
});

// --- LÓGICA DE MODAIS ---
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

// Lógica do Seletor de Perfil
const roleSelector = document.getElementById('role-selector');
if(roleSelector) {
    roleSelector.addEventListener('change', (e) => {
        if (detector) {
            detector.setRole(e.target.value);
            const roleDisp = document.getElementById('user-role-display');
            if(roleDisp) roleDisp.innerText = e.target.value;
            
            if (auth.currentUser) {
                db.collection('users').doc(auth.currentUser.uid).set({
                    role: e.target.value
                }, { merge: true });
            }
        }
    });
}

// --- INIT SYSTEM (Volta para a classe Camera padrão para estabilidade) ---
function initSystem() {
    if (detector) return;

    // Callback vazio pois o detector atualiza a UI diretamente
    detector = new DrowsinessDetector(audioMgr, () => {}); 
    detector.state.monitoring = true;
    detector.updateUI("AGUARDANDO CÂMERA...");

    faceMesh = new FaceMesh({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
    }});

    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    faceMesh.onResults(onResults);

    // Configuração HD na classe Camera padrão
    camera = new Camera(videoElement, {
        onFrame: async () => {
            await faceMesh.send({image: videoElement});
        },
        width: 1280,
        height: 720
    });

    camera.start();
}

function stopSystem() {
    if (camera) camera.stop();
}

// --- LOOP DE PROCESSAMENTO (Conecta Detector Novo + Visual Limpo) ---
function onResults(results) {
    // Desenha o vídeo espelhado
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1);
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        // 1. Desenha a Máscara Sutil (Sem olhos coloridos, apenas malha e contorno)
        drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: '#F0F0F020', lineWidth: 0.5});
        drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#FFD02880', lineWidth: 1.5});
        
        // 2. Calcula EAR aqui no App
        const leftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        const rightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);
        const avgEAR = (leftEAR + rightEAR) / 2.0;

        // 3. Envia para a nova lógica de detecção (0/3 piscadas)
        if (detector) detector.processDetection(avgEAR, 0);
    } else {
        // Se perder o rosto
        if (detector && detector.state.isCalibrated) {
            detector.updateUI("ATENÇÃO: ROSTO NÃO DETECTADO");
        }
    }
    
    canvasCtx.restore(); 
}

// Wrapper legado (caso algo ainda chame, mas o detector manipula DOM direto)
function updateDashboardUI(status) {}

// --- CALIBRAÇÃO (Lógica Visual) ---
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
    
    calibText.innerText = "Mantenha os olhos ABERTOS...";
    calibProgress.style.width = "30%";
    await new Promise(r => setTimeout(r, 3000));
    
    calibText.innerText = "Agora FECHE os olhos...";
    calibProgress.style.width = "60%";
    await new Promise(r => setTimeout(r, 3000));
    
    calibText.innerText = "Calibração Concluída!";
    calibProgress.style.width = "100%";
    
    // Configura Detector com valores padrão seguros
    if(detector) detector.setCalibration(0.15, 0.30, 0.50); 

    setTimeout(() => {
        toggleModal(calibModal, false);
        btnStartCalib.disabled = false;
        calibText.innerText = "Sente-se confortavelmente e olhe para frente.";
        calibProgress.style.width = "0%";
    }, 1000);
});