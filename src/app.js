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
let isCalibrationUnlocked = false;

let lunchTimerInterval = null;

// senha admin
const ADMIN_PASS_REQUIRED = "1234";

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

// --- LOGIN POR E-MAIL E SENHA ---
const formEmailLogin = document.getElementById('form-email-login');
if (formEmailLogin) {
    formEmailLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    const btn = document.getElementById('btn-email-login');
    
    // A fonte da verdade agora é o sessionStorage, validado pelo checkAccess()
    const tokenValido = sessionStorage.getItem('sd_invite_token');

    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerText = tokenValido ? "Criando Perfil..." : "Autenticando...";

    try {
        if (tokenValido) {
            // Tenta criar conta nova
            await auth.createUserWithEmailAndPassword(email, password);
        } else {
            // Tenta login normal
            await auth.signInWithEmailAndPassword(email, password);
        }
    } catch (error) {
        console.error("Erro Auth:", error);
        alert("Erro: " + error.message);
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
});
}

const lockOverlay = document.getElementById('debug-lock-overlay');
const adminPassModal = document.getElementById('admin-pass-modal');
const btnConfirmUnlock = document.getElementById('btn-confirm-unlock');
const unlockInput = document.getElementById('admin-unlock-pass');
const btnReLock = document.getElementById('btn-re-lock');
const btnCancelUnlock = document.getElementById('btn-cancel-unlock');

// 1. Abrir modal ao clicar no cadeado
lockOverlay.addEventListener('click', () => {
    adminPassModal.classList.remove('hidden');
    unlockInput.focus();
});

// 2. Validar senha com o Firebase
// Localize o bloco de validação no app.js e substitua por este:
btnConfirmUnlock.addEventListener('click', async () => {
    const enteredPass = unlockInput.value;
    try {
        const doc = await db.collection('settings').doc('globalConfig').get();
        const correctPass = doc.data()?.calibrationPassword;

        if (enteredPass === correctPass) {
            isCalibrationUnlocked = true; // ATIVA A LÓGICA
            lockOverlay.classList.add('hidden');
            btnReLock.classList.remove('hidden');
            adminPassModal.classList.add('hidden');
            unlockInput.value = "";
        } else {
            alert("Senha incorreta!");
        }
    } catch (error) { console.error(error); }
});

if (btnCancelUnlock) {
    btnCancelUnlock.addEventListener('click', () => {
        // Apenas adiciona hidden; o CSS cuida do resto
        adminPassModal.classList.add('hidden');
        
        // Limpa o input
        unlockInput.value = "";
        
        // Garante que o cadeado volte a ser o foco da interação
        lockOverlay.style.pointerEvents = 'auto';
    });
}

// Garante que o abrir também seja limpo
lockOverlay.addEventListener('click', () => {
    adminPassModal.classList.remove('hidden');
    unlockInput.focus();
});

// 3. Re-bloquear manualmente
btnReLock.addEventListener('click', () => {
    isCalibrationUnlocked = false; // TRAVA A LÓGICA
    lockOverlay.classList.remove('hidden');
    btnReLock.classList.add('hidden');
});

if (sessionStorage.getItem('sd_invite_token')) {
    const loginBtn = document.getElementById('btn-email-login');

    // Forçamos o estado inicial para LOGIN puro. Nada de cadastro por enquanto.
    if (loginBtn) {
        loginBtn.innerHTML = '<span class="material-icons-round">login</span> Entrar';
    }
}

// Verifica se existe token na URL ao carregar
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('convite');

loginView.classList.add('hidden');

const emailBtn = document.getElementById('btn-email-login');

async function checkAccess() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteToken = urlParams.get('convite');
    const storedToken = sessionStorage.getItem('sd_invite_token');
    
    // Prioriza o token da URL, se não houver, usa o do storage
    const tokenToVerify = inviteToken || storedToken;

    if (!tokenToVerify) return;

    try {
        const inviteDoc = await db.collection('invites').doc(tokenToVerify).get();
        
        if (inviteDoc.exists && inviteDoc.data().active && inviteDoc.data().usesLeft > 0) {
            console.log("🎟️ Convite VÁLIDO detectado.");
            
            // Salva para persistir durante o reload do login
            sessionStorage.setItem('sd_invite_token', tokenToVerify);
            
            // Muda o texto do botão de login
            const loginBtn = document.getElementById('btn-email-login');
            if (loginBtn) {
                loginBtn.innerHTML = '<span class="material-icons-round">person_add</span> Finalizar Cadastro';
            }

            // APENAS AGORA, após validar e mudar a UI, limpamos a URL
            if (inviteToken) {
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        } else {
            console.warn("⚠️ Convite inválido ou expirado.");
            sessionStorage.removeItem('sd_invite_token');
        }
    } catch (e) {
        console.error("Erro ao validar acesso:", e);
        // Não removemos o token aqui para evitar deslogar por erro de rede instável
    }
}

// Executa a validação
checkAccess();

if (inviteToken) {
    console.log("🎟️ Token sequestrado da URL:", inviteToken);
    sessionStorage.setItem('sd_invite_token', inviteToken);
    // Limpamos a URL para o Firebase não se perder no redirecionamento
    window.history.replaceState({}, document.title, window.location.pathname);
}

// --- AUTH ---
document.getElementById('btn-google-login').addEventListener('click', () => {
    auth.signInWithPopup(googleProvider).catch((error) => {
        console.error("Erro Auth:", error);
        alert("Erro no login: " + error.message);
    });
});
;
document.getElementById('btn-logout').addEventListener('click', () => {
    stopSystem();
    auth.signOut();
});

// --- FLUXO DE AUTENTICAÇÃO ATUALIZADO (E-mail/Senha + Google + Calibração Individual) ---
auth.onAuthStateChanged(async (user) => {
    if (user) {
        try {
            const userRef = db.collection('users').doc(user.uid);
            const doc = await userRef.get();
            
            // Seu UID específico que NÃO deve ter a foto resetada pelo Google
            const MY_SPECIAL_UID = '0VZVfPXmNjQwunWp1wtk3PHdiub2'; 

            let userData = { role: 'VIGIA', active: true, lgpdAccepted: false };

            if (doc.exists) {
                userData = { ...userData, ...doc.data() };
                if (userData.active === false || userData.disabled === true) throw new Error("⛔ CONTA DESATIVADA.");
                
                // Objeto de atualização
                const updateData = {
                    displayName: user.displayName || userData.displayName || 'Usuário',
                    email: user.email,
                    lastLogin: new Date()
                };

                // SÓ ATUALIZA A FOTO SE NÃO FOR O MEU UID
                if (user.uid !== MY_SPECIAL_UID) {
                    updateData.photoURL = user.photoURL || userData.photoURL || 'https://ui-avatars.com/api/?background=333&color=fff';
                }

                await userRef.set(updateData, { merge: true });
            } 
            else {
                // FLUXO DE NOVO USUÁRIO
                const tokenToUse = sessionStorage.getItem('sd_invite_token');
                if (!tokenToUse) throw new Error("⛔ Link de convite necessário.");

                const inviteRef = db.collection('invites').doc(tokenToUse);
                const inviteDoc = await inviteRef.get(); // O 'allow get: if isSignedIn()' permite isso

                if (!inviteDoc.exists) throw new Error("⛔ Convite inválido.");
                const inviteData = inviteDoc.data();

                const userData = {
                    displayName: user.displayName || user.email.split('@')[0],
                    email: user.email,
                    photoURL: user.photoURL || 'https://ui-avatars.com/api/?background=333&color=fff',
                    role: inviteData.role,
                    inviteUsed: tokenToUse,
                    createdAt: new Date(),
                    active: true,
                    lgpdAccepted: false
                };

                // Agora o Firestore vai aceitar, pois 'inviteUsed' bate com um ID na coleção 'invites'
                // ✅ Consome o convite + cria o perfil em transação (atômico e com rules seguras)
                await db.runTransaction(async (tx) => {
                    const invSnap = await tx.get(inviteRef);
                    if (!invSnap.exists) throw new Error("⛔ Convite inválido.");
                    const inv = invSnap.data() || {};
                    if (!inv.active) throw new Error("⛔ Convite inativo.");
                    if ((inv.usesLeft || 0) <= 0) throw new Error("⛔ Convite esgotado.");

                    // Decrementa 1 uso
                    tx.update(inviteRef, { usesLeft: (inv.usesLeft || 0) - 1 });

                    // Cria o usuário
                    tx.set(userRef, userData, { merge: false });
                });

                // Limpa token local depois de consumir
                sessionStorage.removeItem('sd_invite_token');
            }

            // Transição para LGPD ou APP
            if (!userData.lgpdAccepted) {
                loginView.classList.add('hidden');
                appView.classList.add('hidden');
                lgpdModal.classList.remove('hidden');
                setTimeout(() => lgpdModal.style.opacity = '1', 10);
                setupLgpdEvents(user.uid);
            } else {
                startAppFlow(user, userData.role, userData);
            }

        } catch (error) {
            alert(error.message);
            auth.signOut();
        }
    } else {
        // --- AQUI ESTÁ O TRUQUE ---
        // Se houver um token no storage, não limpamos a tela agressivamente
        const hasToken = sessionStorage.getItem('sd_invite_token');
        if (hasToken) {
            console.log("⏳ Aguardando login para processar convite salvo...");
        }
        showLoginView();
        stopSystem();
    }
});

function showLoginView() {
    // Garante que se houver um convite, a tela de login apareça de forma limpa
    appView.classList.add('hidden');
    appView.classList.remove('active');
    lgpdModal.classList.add('hidden');
    
    loginView.classList.remove('hidden');
    setTimeout(() => loginView.classList.add('active'), 100);
}

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
            // Reduzindo a resolução para 640x360 (ainda 16:9) para aliviar a carga da GPU/WASM.
            // O uso de 'max' é mais seguro que 'ideal' para não forçar cortes se o browser não suportar.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: { max: 1920, ideal: 1080 }, 
                    height: { max: 1080, ideal: 720 }, 
                    facingMode: "user" 
                }
            });
            videoElement.srcObject = stream;
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
    // Resize do canvas SOMENTE quando as dimensões mudarem.
    // Setar .width/.height toda frame destrói e recria o contexto de GPU — custo enorme.
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;
    if (canvasElement.width !== vw || canvasElement.height !== vh) {
        canvasElement.width = vw;
        canvasElement.height = vh;
    }
    
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
        detector.resetDetectionTimer();

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
        // Rosto ausente: Força a verificação de inatividade
        if (detector && detector.state.monitoring) {
            detector.checkInactivity();
        }
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
    btnStartCalib.disabled = true;

    const isFirstTime = !hasPerformedCalibration;

    // Tempos Dinâmicos
    const t_intro = isFirstTime ? 9000 : 2500;
    const t_open = isFirstTime ? 7000 : 4000;
    const t_close = isFirstTime ? 9000 : 5000;
    const t_yawn = isFirstTime ? 8200 : 5000;
    const t_final = isFirstTime ? 4500 : 2000;

    // Agr toca o áudio toda vez. 
    const fullAudio = new Audio('assets/calibracao.mp3');
    fullAudio.volume = 1.0;
    fullAudio.play().catch(e => console.error("Erro ao tocar áudio:", e));

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

function populateUserFilter() {
    if(!userFilter) return;

    db.collection('users').orderBy('displayName').onSnapshot(snapshot => {
        // Mantém a opção "Todos"
        userFilter.innerHTML = '<option value="ALL">Todos os Usuários</option>';
        
        snapshot.forEach(doc => {
            const user = doc.data();
            const option = document.createElement('option');
            option.value = doc.id; // UID
            option.textContent = user.displayName || user.email;
            userFilter.appendChild(option);
        });
    });
}

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
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            if (e.data === "start") {
                // Roda a 20 FPS (50ms) cravado, sem choro do navegador
                // É CRÍTICO que ele chame 'tick' mesmo em background, para forçar o faceMesh.send
                setInterval(() => { postMessage("tick"); }, 50);
            }
        };
    `], { type: "text/javascript" });

    detectionWorker = new Worker(URL.createObjectURL(workerBlob));

    detectionWorker.onmessage = function(e) {
        if (e.data === "tick") {
            // A detecção DEVE rodar sempre. Removemos qualquer verificação de document.hidden.
            if (!isProcessingFrame && faceMesh && videoElement && !videoElement.paused) { 
                isProcessingFrame = true;

                // ANTI-LAG WATCHDOG: Se o MediaPipe travar silenciosamente (ex: spike de CPU,
                // WebGL bloqueado), este timeout libera a trava após 3s.
                // Sem isso, isProcessingFrame ficaria true indefinidamente e nenhum frame
                // seria processado, causando reset dos timers e falsos "sono profundo".
                const watchdogTimer = setTimeout(() => {
                    if (isProcessingFrame) {
                        console.warn("⚠️ WATCHDOG: MediaPipe não respondeu em 3s. Liberando lock.");
                        isProcessingFrame = false;
                    }
                }, 3000);
                
                // Envia pro MediaPipe
                faceMesh.send({image: videoElement})
                    .then(() => { 
                        clearTimeout(watchdogTimer);
                        isProcessingFrame = false; 
                    })
                    .catch((e) => { 
                        // Se o MediaPipe falhar (ex: WebGL/WASM crash)
                        clearTimeout(watchdogTimer);
                        console.error("ERRO CRÍTICO no MediaPipe. Tentando recuperar.", e);
                        isProcessingFrame = false; 
                    });
            }
        }
    };

    // Dá a partida no motor. Enviamos start APENAS uma vez.
    detectionWorker.postMessage("start");
    console.log("🚀 Worker de Background Iniciado (Vigilância Contínua)");
}

function handleVisibilityChange() {
    if (!auth.currentUser || !detector) return;

    if (document.hidden) {
        // A ABA SAIU DO FOCO
        console.warn("😴 PÁGINA INATIVA: A detecção de frames continua. UI desativada.");
        
        // PARE o alarme (A única exceção de segurança de UX que permitimos no background)
        detector.stopAlarm(); 

        detector.state.monitoring = true;
        detector.updateUI("MONITORANDO: SEGUNDO PLANO");
        
    } else {
        // A ABA VOLTOU AO FOCO
        console.log("🚀 PÁGINA ATIVA: Retomando UI. Monitoramento FULL POWER.");

        // Não fazemos nada com o Worker, pois ele roda continuamente.
        detector.state.monitoring = true;
        
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
        // --- INÍCIO DO ALMOÇO ---
        detector.state.lunchStartedAt = Date.now();
        detector.stopAlarm();
        detector.updateUI("PAUSA: ALMOÇO 🍔");
        
        appContainer.classList.add('lunch-mode');
        logLunchAction("LUNCH_START");

        if (lunchTimerInterval) clearInterval(lunchTimerInterval);
        
        lunchTimerInterval = setInterval(() => {
            const elapsed = Date.now() - detector.state.lunchStartedAt;
            
            if (elapsed >= detector.config.LUNCH_CRITICAL_MS) {
                // APENAS TOCA O SOM E AVISA NA TELA (Sem gerar log no Firebase aqui)
                detector.audioManager.playAlert(); 
                detector.state.isAlarmActive = true;
                detector.updateUI("EXCESSO DE ALMOÇO (>1h12)");
            }
        }, 5000);

    } else {
        // --- FINALIZAÇÃO DO ALMOÇO ---
        if (lunchTimerInterval) {
            clearInterval(lunchTimerInterval);
            lunchTimerInterval = null;
        }
        
        const durationMs = Date.now() - detector.state.lunchStartedAt;
        const totalMinutes = Math.floor(durationMs / 60000);

        // REGISTRO ÚNICO: Se excedeu 1h, salva o tempo total agora
        if (durationMs > detector.config.LUNCH_MAX_TIME_MS) {
            let reason = `EXCESSO DE ALMOÇO: ${totalMinutes}min`;
            if (durationMs >= detector.config.LUNCH_CRITICAL_MS) {
                reason = `CRÍTICO: EXCESSO ALMOÇO (${totalMinutes}min)`;
            }
            
            // Chama o log diretamente sem disparar um novo alarme
            detector.logToFirebaseSmart(reason, null);
        }

        detector.stopAlarm();
        detector.updateUI("SISTEMA ATIVO");
        appContainer.classList.remove('lunch-mode');
        
        if(btnLunch) {
            btnLunch.classList.remove('active');
            btnLunch.disabled = true; 
            btnLunch.style.opacity = "0.5";
        }
        
        logLunchAction("LUNCH_END");
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
    console.log("🛠️ FORÇANDO RESET TOTAL DE ALMOÇO...");

    if (lunchTimerInterval) {
        clearInterval(lunchTimerInterval);
        lunchTimerInterval = null;
    }

    isLunching = false;
    localStorage.removeItem(LUNCH_KEY);

    if (detector) {
        detector.state.monitoring = true;
        detector.state.lunchStartedAt = null;
        detector.state.lastFaceDetectedAt = Date.now();
        detector.stopAlarm();
        detector.updateUI("SISTEMA ATIVO");
    }

    if (appContainer) appContainer.classList.remove('lunch-mode');
    
    if (btnLunch) {
        btnLunch.classList.remove('active');
        btnLunch.disabled = false;
        btnLunch.style.opacity = "1";
        btnLunch.style.filter = "none";
    }

    console.log("✅ Reset concluído. Monitoramento retomado.");
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
    debugSliderEyes.addEventListener('input', (e) => {
        // TRAVA LÓGICA: Se não autenticou, reseta o valor e bloqueia
        if (!isCalibrationUnlocked) {
            e.target.value = detector.config.EAR_THRESHOLD;
            alert("Ação bloqueada: Autenticação de supervisor necessária.");
            return;
        }

        const newVal = parseFloat(e.target.value);
        if (detector) {
            detector.config.EAR_THRESHOLD = newVal;
        }
        if(debugThreshValEyes) debugThreshValEyes.innerText = newVal.toFixed(2);
    });

    // Garante o salvamento no Firebase ao soltar o slider
    debugSliderEyes.addEventListener('change', () => {
        if (isCalibrationUnlocked) saveCalibrationToFirebase();
    });
}

const debugSliderHead = document.getElementById('debug-slider-head');
const debugThreshValHead = document.getElementById('debug-thresh-val-head');

if (debugSliderHead) {
    debugSliderHead.addEventListener('input', (e) => {
        // TRAVA LÓGICA: Proteção também para o sensor de cabeça
        if (!isCalibrationUnlocked) {
            e.target.value = detector.config.HEAD_RATIO_THRESHOLD;
            alert("Ação bloqueada: Autenticação de supervisor necessária.");
            return;
        }

        const newVal = parseFloat(e.target.value);
        if (detector) {
            detector.config.HEAD_RATIO_THRESHOLD = newVal;
        }
        if(debugThreshValHead) debugThreshValHead.innerText = newVal.toFixed(2);
    });

    // Garante o salvamento no Firebase ao soltar o slider
    debugSliderHead.addEventListener('change', () => {
        if (isCalibrationUnlocked) saveCalibrationToFirebase();
    });
}

// Torna global pro Detector conseguir chamar
window.captureSnapshot = () => {
    // Verifica se o elemento de vídeo existe e está carregado
    if (!videoElement) return Promise.resolve(null);
    
    // FIX: Se o vídeo não tiver dimensões (ex: display none), aborta
    if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        console.warn("⚠️ Snapshot abortado: Vídeo sem dimensões.");
        return Promise.resolve(null);
    }

    // ANTI-LAG: Usa requestIdleCallback para não bloquear a thread de detecção.
    // O toDataURL() é síncrono e pesado — executar em idle evita travar o loop principal.
    return new Promise((resolve) => {
        const doCapture = () => {
            try {
                // Resolução reduzida: 320x240 é suficiente para identificar o operador
                // e é ~25x mais rápido de codificar que 1080p (9x menos pixels + JPEG mais leve).
                const SNAP_W = 320;
                const SNAP_H = 240;

                const tempCanvas = document.createElement('canvas');
                tempCanvas.width  = SNAP_W;
                tempCanvas.height = SNAP_H;
                const tempCtx = tempCanvas.getContext('2d');

                // Espelha horizontalmente (mirror) igual ao preview
                tempCtx.save();
                tempCtx.translate(SNAP_W, 0);
                tempCtx.scale(-1, 1);
                tempCtx.drawImage(videoElement, 0, 0, SNAP_W, SNAP_H);
                tempCtx.restore();

                const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.6);

                if (dataUrl && dataUrl.length > 100) {
                    console.log(`📸 Snapshot capturado (${SNAP_W}x${SNAP_H} — ${Math.round(dataUrl.length/1024)}KB)`);
                    resolve(dataUrl);
                } else {
                    console.warn("⚠️ Falha ao gerar snapshot.");
                    resolve(null);
                }
            } catch(e) {
                console.error("❌ Erro no snapshot:", e);
                resolve(null);
            }
        };

        // requestIdleCallback: executa só quando o browser NÃO está ocupado com frames.
        // Fallback para setTimeout(0) em browsers sem suporte (Safari antigo).
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(doCapture, { timeout: 2000 });
        } else {
            setTimeout(doCapture, 0);
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