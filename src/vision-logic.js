// Pontos chave do MediaPipe FaceMesh
export const LANDMARKS = {
    LEFT_EYE: [362, 385, 387, 263, 373, 380],
    RIGHT_EYE: [33, 160, 158, 133, 153, 144],
    MOUTH_INNER: [13, 14, 61, 291],
    
    // PONTOS PARA CABEÇA ("T-Zone" Method)
    LEFT_EYE_OUTER: 33,   
    RIGHT_EYE_OUTER: 263, 
    MOUTH_TOP: 13,
    
    // NOVOS PONTOS PARA FILTRO DE "OLHAR PRA CIMA"
    NOSE_TIP: 1,
    CHIN: 9,      // Ponto inferior do queixo (usando 152 as vezes oscila, 199 ou 9 sao bons)
    GLABELLA: 168 // Ponto entre os olhos (fixo)
};

function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)); // 2D basta
}

export function calculateEAR(landmarks, indices) {
    const p2 = landmarks[indices[1]]; 
    const p6 = landmarks[indices[5]]; 
    const p3 = landmarks[indices[2]]; 
    const p5 = landmarks[indices[4]]; 
    const p1 = landmarks[indices[0]]; 
    const p4 = landmarks[indices[3]]; 
    
    const ver1 = getDistance(p2, p6);
    const ver2 = getDistance(p3, p5);
    const hor = getDistance(p1, p4);
    
    if (hor === 0) return 0.0;
    return (ver1 + ver2) / (2.0 * hor);
}

export function calculateMAR(landmarks) {
    const indices = LANDMARKS.MOUTH_INNER;
    return getDistance(landmarks[indices[0]], landmarks[indices[1]]) / 
           getDistance(landmarks[indices[2]], landmarks[indices[3]]);
}

export function calculateHeadTilt(landmarks) {
    const leftEye = landmarks[LANDMARKS.LEFT_EYE_OUTER]; 
    const rightEye = landmarks[LANDMARKS.RIGHT_EYE_OUTER];
    const mouthTop = landmarks[LANDMARKS.MOUTH_TOP];

    if (!leftEye || !rightEye || !mouthTop) return 0;

    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const eyeCenterY = (leftEye.y + rightEye.y) / 2;

    const verticalDist = Math.hypot(mouthTop.x - eyeCenterX, mouthTop.y - eyeCenterY);
    const horizontalDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);

    if (horizontalDist === 0) return 0;
    return verticalDist / horizontalDist;
}

// --- NOVA LÓGICA: DETECTOR DE "OLHAR PARA CIMA" ---
export function calculatePitchRatio(landmarks) {
    const nose = landmarks[LANDMARKS.NOSE_TIP];
    const chin = landmarks[152]; // Queixo (ponto mais baixo)
    const glabella = landmarks[LANDMARKS.GLABELLA]; // Entre os olhos

    if (!nose || !chin || !glabella) return 1.0;

    // Distância Nariz -> Queixo
    const noseToChin = getDistance(nose, chin);
    
    // Distância Nariz -> Testa (Glabella)
    const noseToBrow = getDistance(nose, glabella);

    if (noseToBrow === 0) return 1.0;

    // Se olhar pra cima: Queixo se afasta do nariz (Ratio AUMENTA)
    // Se olhar pra baixo: Queixo entra pra dentro (Ratio DIMINUI)
    return noseToChin / noseToBrow;
}