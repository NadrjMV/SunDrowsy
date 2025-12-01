// Índices do MediaPipe
export const LANDMARKS = {
    // Olhos (Pálpebras para EAR)
    LEFT_EYE: [362, 385, 387, 263, 373, 380],
    RIGHT_EYE: [33, 160, 158, 133, 153, 144],
    // Boca (Interno para MAR)
    MOUTH_INNER: [13, 14, 61, 291],
    
    // PONTOS PARA CABEÇA (Novo Método "T-Zone")
    NOSE_TIP: 1,
    LEFT_EYE_OUTER: 33,  // Canto externo olho esq
    RIGHT_EYE_OUTER: 263, // Canto externo olho dir
    MOUTH_TOP: 13,        // Lábio superior
    MOUTH_BOTTOM: 14      // Lábio inferior
};

function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2) + Math.pow(p1.z - p2.z, 2));
}

export function calculateEAR(landmarks, indices) {
    const p1 = landmarks[indices[0]]; 
    const p2 = landmarks[indices[1]]; 
    const p3 = landmarks[indices[2]]; 
    const p4 = landmarks[indices[3]]; 
    const p5 = landmarks[indices[4]]; 
    const p6 = landmarks[indices[5]]; 
    const ver1 = getDistance(p2, p6);
    const ver2 = getDistance(p3, p5);
    const hor = getDistance(p1, p4);
    if (hor === 0) return 0.0;
    return (ver1 + ver2) / (2.0 * hor);
}

export function calculateMAR(landmarks) {
    const indices = LANDMARKS.MOUTH_INNER;
    const p_top = landmarks[indices[0]];
    const p_bottom = landmarks[indices[1]];
    const p_left = landmarks[indices[2]];
    const p_right = landmarks[indices[3]];
    const ver = getDistance(p_top, p_bottom);
    const hor = getDistance(p_left, p_right);
    if (hor === 0) return 0.0;
    return ver / hor;
}

// *** NOVA LÓGICA DE CABEÇA BAIXA ("T-ZONE") ***
export function calculateHeadTilt(landmarks) {
    // T-Zone: Ponto central dos olhos
    const leftEye = landmarks[33];  // Canto externo esquerdo
    const rightEye = landmarks[263]; // Canto externo direito
    
    // Média para achar o centro dos olhos
    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const eyeCenterY = (leftEye.y + rightEye.y) / 2;
    const eyeCenterZ = (leftEye.z + rightEye.z) / 2;

    // Boca (Lábio Superior)
    const mouthTop = landmarks[13];

    // Distância Vertical (Olhos até Boca)
    // Usamos Math.hypot para vetor 3D ou 2D. Aqui 2D resolve bem e é mais estável para tilt.
    const verticalDist = Math.hypot(mouthTop.x - eyeCenterX, mouthTop.y - eyeCenterY);

    // Distância Horizontal (Largura do Rosto)
    const horizontalDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);

    if (horizontalDist === 0) return 0;

    // Ratio: Se a cabeça abaixa, a distância vertical diminui visualmente na câmera.
    // Retorna o valor puro.
    return verticalDist / horizontalDist;
}