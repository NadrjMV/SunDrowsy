export class AudioManager {
    constructor(audioFile) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.gainNode = this.audioContext.createGain();
        this.buffer = null;
        this.isPlaying = false;
        
        this.loadSound(audioFile);
    }

    async loadSound(url) {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            this.buffer = await this.audioContext.decodeAudioData(arrayBuffer);
        //    console.log("🔊 Áudio carregado com sucesso!");
        } catch (e) {
            console.error("❌ Erro ao carregar áudio:", e);
        }
    }

    playAlert() {
        if (!this.buffer) {
            console.warn("⚠️ Buffer de áudio vazio!");
            return;
        }
        
        // Se já estiver tocando, não sobrepõe
        if (this.isPlaying) return;

        // Tenta acordar o contexto de áudio (Navegadores bloqueiam autoplay)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().then(() => {
                console.log("🔊 AudioContext retomado!");
            });
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffer;
        source.loop = true; 

        // Volume Boost (300%)
        this.gainNode.gain.value = 3.0; 
        
        source.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        
        source.start(0);
        this.currentSource = source;
        this.isPlaying = true;
    //    console.log("🔊 TOCANDO ALARME!");
    }

    stopAlert() {
        if (this.currentSource) {
            try {
                this.currentSource.stop();
            } catch(e) { /* Ignora erro se já parou */ }
            this.currentSource = null;
        }
        this.isPlaying = false;
    //    console.log("🔇 Alarme parado.");
    }
}