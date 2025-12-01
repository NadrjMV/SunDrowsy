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
    // 1. Pega ponto central entre os olhos (média dos cantos)
    const leftEye = landmarks[LANDMARKS.LEFT_EYE_OUTER];
    const rightEye = landmarks[LANDMARKS.RIGHT_EYE_OUTER];
    const eyeCenter = {
        x: (leftEye.x + rightEye.x) / 2,
        y: (leftEye.y + rightEye.y) / 2,
        z: (leftEye.z + rightEye.z) / 2
    };

    // 2. Pega boca (lábio superior)
    const mouthTop = landmarks[LANDMARKS.MOUTH_TOP];

    // 3. Altura Vertical (Olhos até Boca)
    // Quando a cabeça abaixa, o queixo entra pra dentro e essa distância encurta visualmente
    const verticalDist = getDistance(eyeCenter, mouthTop);

    // 4. Largura Horizontal (Olho a Olho)
    // Essa distância se mantém constante
    const horizontalDist = getDistance(leftEye, rightEye);

    // 5. Ratio
    if (horizontalDist === 0) return { ratio: 1.0, isHeadDown: false };
    
    // Normalização: Multiplica por 1.5 para ficar numa escala confortável (perto de 1.0)
    const ratio = (verticalDist / horizontalDist) * 1.5;

    // Threshold de segurança: 0.70
    // Se cair abaixo de 0.70, significa que a boca está "subindo" em direção aos olhos (cabeça baixou)
    return {
        ratio: ratio,
        isHeadDown: ratio < 0.70 
    };
}