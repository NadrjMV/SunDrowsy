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
        // ESCONDE LOGIN
        loginView.classList.remove('active');
        loginView.classList.add('hidden');
        
        // MOSTRA APP (com pequeno delay para animação funcionar)
        appView.classList.remove('hidden');
        setTimeout(() => appView.classList.add('active'), 100);

        // Preenche dados do usuário
        document.getElementById('user-name').innerText = user.displayName;
        document.getElementById('user-photo').src = user.photoURL;
        
        initSystem();
        
        // Carrega calibração
        try {
            const doc = await db.collection('users').doc(user.uid).get();
            if(doc.exists && doc.data().calibration) {
                detector.config = { ...detector.config, ...doc.data().calibration };
                detector.state.isCalibrated = true;
                console.log("Calibração carregada.");
            } else {
                toggleModal(calibModal, true);
            }
        } catch (e) {
            console.log("Erro calibração:", e);
            toggleModal(calibModal, true);
        }
        
    } else {
        // LOGOUT: INVERTE A LÓGICA
        appView.classList.remove('active');
        appView.classList.add('hidden');
        
        loginView.classList.remove('hidden');
        setTimeout(() => loginView.classList.add('active'), 100);
        
        stopSystem();
    }
});

// Fechar modais ao clicar no X
document.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal');
        toggleModal(modal, false);
    });
});

// Fechar ao clicar fora
window.addEventListener('click', (e) => {
    if (e.target === calibModal) toggleModal(calibModal, false);
    if (e.target === tutorialModal) toggleModal(tutorialModal, false);
});

// Botões de Ação
btnFabCalibrate.addEventListener('click', () => toggleModal(calibModal, true));
btnTutorialOpen.addEventListener('click', () => {
    // Reseta o tutorial para o passo 1 sempre que abrir
    currentStep = 1;
    updateWizard(1);
    toggleModal(tutorialModal, true);
});

// --- INICIALIZAÇÃO DO MEDIAPIPE ---
function initSystem() {
    if (detector) return; // Evita dupla inicialização

    detector = new DrowsinessDetector(audioMgr, updateDashboardUI);
    detector.state.monitoring = true;

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

// --- LOOP PRINCIPAL ---
function onResults(results) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // 1. Aplica espelhamento no contexto
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1);
    
    // 2. Desenha a imagem espelhada
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        // 3. Desenha a malha (LANDMARKS) no contexto ESPELHADO
        drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: '#C0C0C040', lineWidth: 1});
        
        if (detector) detector.processLandmarks(landmarks);
    }
    
    // 4. RESTAURA o contexto para o normal (para futura escrita de texto, etc.)
    canvasCtx.restore(); 
}

// --- UI UPDATES ---
function updateDashboardUI(status) {
    document.getElementById('system-status').innerText = status.text;
    document.getElementById('blink-counter').innerText = status.blinks || 0;
    
    if (status.alarm) {
        alertOverlay.classList.remove('hidden');
        document.getElementById('fatigue-level').innerText = "CRÍTICO";
        document.getElementById('fatigue-level').className = "value danger";
    } else {
        alertOverlay.classList.add('hidden');
        document.getElementById('fatigue-level').innerText = status.blinks >= 3 ? "ALTA" : "NORMAL";
        document.getElementById('fatigue-level').className = status.blinks >= 3 ? "value danger" : "value safe";
    }
}


// --- LÓGICA DO TUTORIAL WIZARD ---
let currentStep = 1;
const totalSteps = 3;

const wizardSteps = document.querySelectorAll('.wizard-step');
const dots = document.querySelectorAll('.dot');
const btnNext = document.getElementById('btn-next-step');
const btnPrev = document.getElementById('btn-prev-step');

function updateWizard(step) {
    // Esconde todos
    wizardSteps.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    
    // Mostra atual
    const activeStep = document.querySelector(`.wizard-step[data-step="${step}"]`);
    const activeDot = document.querySelector(`.dot[data-index="${step}"]`);
    
    if(activeStep) activeStep.classList.add('active');
    if(activeDot) activeDot.classList.add('active');
    
    // Controla botões
    if (step === 1) {
        btnPrev.style.opacity = '0';
        btnPrev.style.pointerEvents = 'none';
    } else {
        btnPrev.style.opacity = '1';
        btnPrev.style.pointerEvents = 'all';
    }

    if (step === totalSteps) {
        btnNext.innerHTML = 'Começar <span class="material-icons-round">check</span>';
    } else {
        btnNext.innerHTML = 'Próximo';
    }
}

btnNext.addEventListener('click', () => {
    if (currentStep < totalSteps) {
        currentStep++;
        updateWizard(currentStep);
    } else {
        // Fim do tutorial
        toggleModal(document.getElementById('tutorial-modal'), false);
    }
});

btnPrev.addEventListener('click', () => {
    if (currentStep > 1) {
        currentStep--;
        updateWizard(currentStep);
    }
});

// --- LÓGICA DE MODAIS ---
const closeCalibBtn = document.getElementById('close-calib');
const closeTutorialBtn = document.getElementById('close-tutorial');

function toggleModal(modal, show) {
    if (show) {
        modal.classList.remove('hidden');
        // Pequeno delay para permitir a transição CSS de opacidade
        setTimeout(() => { modal.style.opacity = '1'; }, 10);
    } else {
        modal.style.opacity = '0';
        setTimeout(() => modal.classList.add('hidden'), 300);
    }
}

// --- LÓGICA DO SELETOR DE PERFIL ---
const roleSelector = document.getElementById('role-selector');
if(roleSelector) {
    roleSelector.addEventListener('change', (e) => {
        if (detector) {
            detector.setRole(e.target.value);
            // Salva a nova função do usuário no Firebase
            if (auth.currentUser) {
                db.collection('users').doc(auth.currentUser.uid).update({
                    role: e.target.value
                });
            }
        }
    });
}

// Fechar com X
if(closeCalibBtn) closeCalibBtn.addEventListener('click', () => toggleModal(calibModal, false));
if(closeTutorialBtn) closeTutorialBtn.addEventListener('click', () => toggleModal(tutorialModal, false));


// --- CALIBRAÇÃO LÓGICA ---
btnStartCalib.addEventListener('click', async () => {
    // Resume audio context
    audioMgr.audioContext.resume();
    
    btnStartCalib.disabled = true;
    
    // FASE 1: Olhos Abertos
    calibText.innerText = "Mantenha os olhos ABERTOS...";
    calibProgress.style.width = "30%";
    
    await new Promise(r => setTimeout(r, 3000));
    
    // FASE 2: Olhos Fechados
    calibText.innerText = "Agora FECHE os olhos...";
    calibProgress.style.width = "60%";
    await new Promise(r => setTimeout(r, 3000));
    
    calibText.innerText = "Calibração Concluída!";
    calibProgress.style.width = "100%";
    
    // Calibração Padrão (Fallback seguro)
    detector.setCalibration(0.15, 0.30, 0.50); 

    setTimeout(() => {
        toggleModal(calibModal, false);
        btnStartCalib.disabled = false;
        calibText.innerText = "Sente-se confortavelmente e olhe para frente.";
        calibProgress.style.width = "0%";
    }, 1000);
});