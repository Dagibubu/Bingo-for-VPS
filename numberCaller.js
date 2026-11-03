const EventEmitter = require('events');

class NumberCaller extends EventEmitter {
    constructor(drawInterval = 4000, options = {}) {
        super();

        this.allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
        this.remainingNumbers = [...this.allNumbers];
        this.calledNumbers = [];
        this.drawInterval = drawInterval;

        // How long to wait before the FIRST draw only.
        // Defaults to the drawInterval so behaviour is unchanged if not provided.
        this.firstDrawDelay = Number.isFinite(options.firstDrawDelay)
            ? Math.max(0, options.firstDrawDelay)
            : drawInterval;

        this.timer = null;
        this.isRunning = false;
        this.isPaused = false;

        // Whether the very first draw has happened yet
        this.firstDrawDone = false;

        console.log(`🎰 NumberCaller created — interval: ${drawInterval}ms, firstDrawDelay: ${this.firstDrawDelay}ms`);
    }

    reset() {
        this.stop();
        this.remainingNumbers = [...this.allNumbers];
        this.calledNumbers = [];
        this.isRunning = false;
        this.isPaused = false;
        this.firstDrawDone = false;
        console.log('🔄 NumberCaller reset');
        this.emit('reset');
    }

    shuffle() {
        for (let i = this.remainingNumbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.remainingNumbers[i], this.remainingNumbers[j]] =
                [this.remainingNumbers[j], this.remainingNumbers[i]];
        }
        console.log(`🔀 Shuffled — first 5: ${this.remainingNumbers.slice(0, 5).join(', ')}`);
    }

    setDrawInterval(ms) {
        console.log(`⏱️  setDrawInterval called with ${ms}ms`);
        this.drawInterval = ms;
        if (this.isRunning) {
            this.stop();
            this.start();
        }
    }

    setFirstDrawDelay(ms) {
        this.firstDrawDelay = Math.max(0, Number(ms) || 0);
        console.log(`⏱️  setFirstDrawDelay: ${this.firstDrawDelay}ms`);
    }

    /**
     * Start calling numbers.
     *
     * The FIRST draw is delayed by `firstDrawDelay` (defaults to drawInterval).
     * Every draw AFTER that happens every `drawInterval`.
     *
     * This gives the client time to play the "game started" audio before
     * the first number's sound fires.
     */
    start() {
        if (this.isRunning) this.stop();
        if (this.remainingNumbers.length === 75) this.shuffle();

        // ============================================================
        // GUARD: ensure drawInterval is a valid number
        // ============================================================
        if (!Number.isFinite(this.drawInterval) || this.drawInterval < 100) {
            console.warn(`⚠️  Invalid drawInterval (${this.drawInterval}), defaulting to 4000ms`);
            this.drawInterval = 4000;
        }

        // ============================================================
        // GUARD: ensure firstDrawDelay is a valid number
        // ============================================================
        if (!Number.isFinite(this.firstDrawDelay) || this.firstDrawDelay < 0) {
            console.warn(`⚠️  Invalid firstDrawDelay (${this.firstDrawDelay}), defaulting to ${this.drawInterval}ms`);
            this.firstDrawDelay = this.drawInterval;
        }

        this.isRunning = true;
        this.isPaused = false;
        this.firstDrawDone = false;

        console.log(
            `▶️  NumberCaller.start() — first draw in ${this.firstDrawDelay}ms, ` +
            `then every ${this.drawInterval}ms (remaining=${this.remainingNumbers.length})`
        );

        // ── Schedule the FIRST draw after firstDrawDelay ──
        this.timer = setTimeout(() => {
            if (!this.isRunning || this.isPaused) return;
            this.firstDrawDone = true;

            // Fire the first number
            this.drawNext();

            // Then schedule the recurring interval for subsequent draws
            if (this.isRunning && !this.isPaused && this.remainingNumbers.length > 0) {
                this.timer = setInterval(() => {
                    if (!this.isRunning || this.isPaused) return;
                    this.drawNext();
                }, this.drawInterval);
            }
        }, this.firstDrawDelay);

        // Notify listeners of the start details
        this.emit('started', {
            interval: this.drawInterval,
            firstDelay: this.firstDrawDelay
        });
    }

    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            clearInterval(this.timer);
        }
        this.timer = null;
        this.isRunning = false;
        console.log('⏹️  NumberCaller stopped');
    }

    pause() {
        if (this.timer) {
            clearTimeout(this.timer);
            clearInterval(this.timer);
        }
        this.timer = null;
        this.isRunning = false;
        this.isPaused = true;
        console.log('⏸️  NumberCaller paused');
        this.emit('paused');
    }

    resume() {
        if (this.isPaused && this.remainingNumbers.length > 0) {
            this.isPaused = false;
            console.log('▶️  NumberCaller resuming...');
            this.start();
            this.emit('resumed');
        }
    }

    drawNext() {
        if (this.remainingNumbers.length === 0) {
            this.stop();
            this.emit('completed', { calledNumbers: [...this.calledNumbers] });
            return null;
        }

        const number = this.remainingNumbers.shift();
        this.calledNumbers.push(number);

        console.log(`🎲 DRAWING: ${number} (${this.calledNumbers.length}/75) — ${this.remainingNumbers.length} left`);

        const state = {
            number,
            calledNumbers: [...this.calledNumbers],
            remaining: this.remainingNumbers.length,
            position: this.calledNumbers.length
        };

        this.emit('numberCalled', state);

        if (this.remainingNumbers.length === 0) {
            this.stop();
            this.emit('completed', { calledNumbers: [...this.calledNumbers] });
        }

        return number;
    }

    getState() {
        return {
            remaining: this.remainingNumbers.length,
            calledNumbers: [...this.calledNumbers],
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            drawInterval: this.drawInterval,
            firstDrawDelay: this.firstDrawDelay,
            firstDrawDone: this.firstDrawDone
        };
    }
}

module.exports = NumberCaller;