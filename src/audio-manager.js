export class AudioManager {
    constructor(audioFile) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.gainNode = this.audioContext.createGain();
        this.buffer = null;
        this.isPlaying = false;
        
        // Carrega o arquivo de áudio
        this.loadSound(audioFile);
    }

    async loadSound(url) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        this.buffer = await this.audioContext.decodeAudioData(arrayBuffer);
    }

    playAlert() {
        if (this.isPlaying || !this.buffer) return;

        // Resume context se estiver suspenso (política de browsers)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffer;
        source.loop = true; // Loop infinito até parar

        // SETUP DO BOOST: Volume 3.0 = 300%
        this.gainNode.gain.value = 3.0; 
        
        source.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        
        source.start(0);
        this.currentSource = source;
        this.isPlaying = true;
    }

    stopAlert() {
        if (this.currentSource) {
            this.currentSource.stop();
            this.currentSource = null;
            this.isPlaying = false;
        }
    }
}