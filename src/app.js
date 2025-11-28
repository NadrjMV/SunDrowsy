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
        loginView.classList.remove('active');
        loginView.classList.add('hidden');
        appView.classList.remove('hidden');
        setTimeout(() => appView.classList.add('active'), 100);

        document.getElementById('user-name').innerText = user.displayName;
        document.getElementById('user-photo').src = user.photoURL;
        
        initSystem();
        
        try {
            console.log("☁️ [FIREBASE] Buscando perfil do usuário...");
            const doc = await db.collection('users').doc(user.uid).get();
            let userRole = 'MOTORISTA'; 

            if(doc.exists) {
                // Role
                if(doc.data().role) {
                    userRole = doc.data().role;
                    console.log(`   └─ Perfil encontrado: ${userRole}`);
                }
                
                // Calibração
                const savedData = doc.data().calibration;
                if(savedData && detector) {
                    // Carrega APENAS EAR/MAR para não sobrescrever o tempo crítico
                    if (savedData.EAR_THRESHOLD) detector.config.EAR_THRESHOLD = savedData.EAR_THRESHOLD;
                    if (savedData.MAR_THRESHOLD) detector.config.MAR_THRESHOLD = savedData.MAR_THRESHOLD;
                    detector.state.isCalibrated = true;
                    
                    // --- LOG DE SUCESSO DE CARREGAMENTO ---
                    console.log("☁️ [FIREBASE] Calibração carregada com SUCESSO!");
                    console.log(`   └─ EAR da Nuvem: ${savedData.EAR_THRESHOLD.toFixed(4)}`);
                } else {
                    console.log("⚠️ [FIREBASE] Nenhuma calibração salva encontrada.");
                    toggleModal(calibModal, true);
                }
            } else {
                console.log("⚠️ [FIREBASE] Usuário novo (sem documento).");
                toggleModal(calibModal, true);
            }
            
            // Sincroniza Role
            if(detector) detector.setRole(userRole);
            const roleSel = document.getElementById('role-selector');
            const roleDisp = document.getElementById('user-role-display');
            if(roleSel) roleSel.value = userRole;
            if(roleDisp) roleDisp.innerText = userRole;

        } catch (e) {
            console.error("❌ [FIREBASE] Erro ao carregar dados:", e);
            toggleModal(calibModal, true);
        }
        
    } else {
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
            // Visual leve
            drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#FFD028', lineWidth: 1.5});
        }
        
        const leftEAR = calculateEAR(landmarks, LANDMARKS.LEFT_EYE);
        const rightEAR = calculateEAR(landmarks, LANDMARKS.RIGHT_EYE);

        if (detector) detector.processDetection(leftEAR, rightEAR, 0);
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
    
    calibText.innerText = "Mantenha os olhos ABERTOS...";
    calibProgress.style.width = "30%";
    await new Promise(r => setTimeout(r, 3000));
    calibText.innerText = "Agora FECHE os olhos...";
    calibProgress.style.width = "60%";
    await new Promise(r => setTimeout(r, 3000));
    calibText.innerText = "Calibração Concluída!";
    calibProgress.style.width = "100%";
    
    if(detector) detector.setCalibration(0.15, 0.35, 0.50); 

    setTimeout(() => {
        toggleModal(calibModal, false);
        btnStartCalib.disabled = false;
        calibText.innerText = "Sente-se confortavelmente e olhe para frente.";
        calibProgress.style.width = "0%";
    }, 1000);
});