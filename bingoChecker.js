/**
 * bingoChecker.js
 * Correctly parses column-major cartela storage (B,I,N,G,O columns)
 * and validates BINGO patterns.
 */

function parseGrid(cartelaNumbers) {
    let nums;
    if (typeof cartelaNumbers === 'string') {
        nums = cartelaNumbers.split(',').map(Number);
    } else if (Array.isArray(cartelaNumbers)) {
        if (cartelaNumbers.length === 25 && !Array.isArray(cartelaNumbers[0])) {
            nums = cartelaNumbers;
        } else {
            // Already a 5x5 grid — return as-is
            return cartelaNumbers;
        }
    } else {
        return null;
    }

    if (nums.length !== 25) return null;

    // Build ROW-major 5x5 grid from COLUMN-major flat array
    // Card layout (as displayed):
    //   Row 0: B[0], I[0], N[0], G[0], O[0]
    //   Row 1: B[1], I[1], N[1], G[1], O[1]
    //   ...
    const grid = Array(5).fill().map(() => Array(5).fill(0));
    for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 5; row++) {
            grid[row][col] = nums[col * 5 + row];
        }
    }
    // Free space: center cell is always marked
    grid[2][2] = 0;
    return grid;
}

function checkBingo(cartelaNumbers, calledNumbers, patterns = null, patternsRequired = 1) {
    const grid = parseGrid(cartelaNumbers);
    if (!grid || grid.length !== 5) {
        return { valid: false, reason: 'Invalid cartela format' };
    }

    const lastCalled = calledNumbers[calledNumbers.length - 1];
    const calledSet = new Set(calledNumbers);

    const isMarked = (n) => n === 0 || calledSet.has(n);
    const containsLast = (line) => lastCalled != null && line.includes(lastCalled);

    // Build pattern list
    let patternList = [];
    if (patterns) {
        if (Array.isArray(patterns)) patternList = patterns;
        else if (typeof patterns === 'string') patternList = patterns.split(',').map(p => p.trim());
    }
    if (patternList.length === 0) {
        patternList = ['horizontal', 'vertical', 'diagonal', 'four_corners', 'full_house'];
    }

    const foundPatterns = [];   // ALL complete patterns on the card
    const freshPatterns = [];   // patterns completed by the most recent called number
    const patternDetails = {};

    // A pattern counts toward patternsRequired as soon as it is fully marked.
    // The "must contain the last called number" rule is NOT applied per-line:
    // a drawn ball sits in only one row/column, so requiring EVERY line to
    // contain it made multi-line wins (2+ patterns) mathematically impossible.
    const registerPattern = (name, detail, cells) => {
        if (!cells.every(isMarked)) return;
        foundPatterns.push(name);
        patternDetails[name] = detail;
        if (containsLast(cells)) freshPatterns.push(name);
    };

    // Horizontal
    if (patternList.includes('horizontal') || patternList.includes('row')) {
        for (let r = 0; r < 5; r++) {
            registerPattern(`Horizontal Row ${r + 1}`, { type: 'horizontal', row: r + 1 }, grid[r]);
        }
    }

    // Vertical
    if (patternList.includes('vertical') || patternList.includes('column')) {
        const letters = ['B', 'I', 'N', 'G', 'O'];
        for (let c = 0; c < 5; c++) {
            const col = [grid[0][c], grid[1][c], grid[2][c], grid[3][c], grid[4][c]];
            registerPattern(`Vertical Column ${letters[c]}`, { type: 'vertical', column: c + 1 }, col);
        }
    }

    // Diagonal
    if (patternList.includes('diagonal')) {
        registerPattern('Main Diagonal', { type: 'diagonal', which: 'main' },
            [grid[0][0], grid[1][1], grid[2][2], grid[3][3], grid[4][4]]);
        registerPattern('Anti Diagonal', { type: 'diagonal', which: 'anti' },
            [grid[0][4], grid[1][3], grid[2][2], grid[3][1], grid[4][0]]);
    }

    // Four corners
    if (patternList.includes('four_corners') || patternList.includes('corners')) {
        registerPattern('Four Corners', { type: 'four_corners' },
            [grid[0][0], grid[0][4], grid[4][0], grid[4][4]]);
    }

    // Full house
    if (patternList.includes('full_house') || patternList.includes('blackout')) {
        registerPattern('Full House', { type: 'full_house' }, grid.flat());
    }

    // Win = enough complete patterns, AND the win was triggered by the most
    // recent ball (at least one pattern contains the last called number).
    // This keeps the existing "no stale claims" rule intact.
    const hasRequired = foundPatterns.length >= patternsRequired;
    const completedByLastCall = freshPatterns.length > 0;

    if (hasRequired && completedByLastCall) {
        return {
            valid: true,
            type: freshPatterns[0] || foundPatterns[0] || 'BINGO',
            patterns: foundPatterns,
            patternDetails,
            lastCalledNumber: lastCalled
        };
    }

    if (hasRequired && !completedByLastCall) {
        // The ball that first completed the required patterns: the win the player missed.
        let missedNumber = null;
        for (let i = 1; i < calledNumbers.length; i++) {
            const r = checkBingo(cartelaNumbers, calledNumbers.slice(0, i), patterns, patternsRequired);
            if (r.valid || r.late) { missedNumber = calledNumbers[i - 1]; break; }
        }
        return {
            valid: false,
            late: true,
            missedNumber,
            reason: `Card has ${foundPatterns.length} complete pattern(s), but none was completed by the last called number (${lastCalled})`,
            patterns: foundPatterns
        };
    }

    return {
        valid: false,
        reason: `Found ${foundPatterns.length}/${patternsRequired} patterns`,
        patterns: foundPatterns
    };
}

module.exports = { checkBingo };