// Índices do MediaPipe (Mesmos do Python)
export const LANDMARKS = {
    LEFT_EYE: [362, 385, 387, 263, 373, 380],
    RIGHT_EYE: [33, 160, 158, 133, 153, 144],
    MOUTH_INNER: [13, 14, 61, 291]
};

// Distância Euclidiana 3D
function getDistance(p1, p2) {
    return Math.sqrt(
        Math.pow(p1.x - p2.x, 2) +
        Math.pow(p1.y - p2.y, 2) +
        Math.pow(p1.z - p2.z, 2)
    );
}

// Cálculo do EAR (Eye Aspect Ratio)
export function calculateEAR(landmarks, indices) {
    // MediaPipe retorna array, indices mapeiam os pontos
    const p1 = landmarks[indices[0]]; // Canto esquerdo
    const p2 = landmarks[indices[1]]; // Topo 1
    const p3 = landmarks[indices[2]]; // Topo 2
    const p4 = landmarks[indices[3]]; // Canto direito
    const p5 = landmarks[indices[4]]; // Base 2
    const p6 = landmarks[indices[5]]; // Base 1

    const ver1 = getDistance(p2, p6);
    const ver2 = getDistance(p3, p5);
    const hor = getDistance(p1, p4);

    if (hor === 0) return 0.0;
    return (ver1 + ver2) / (2.0 * hor);
}

// Cálculo do MAR (Mouth Aspect Ratio) - Simplificado
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