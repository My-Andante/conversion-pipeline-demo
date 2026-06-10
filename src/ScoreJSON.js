/**
 * ScoreJSON - Compact JSON format for piano scores
 * Converts to/from MusicXML for rendering with OSMD
 * 
 * Format:
 * {
 *   "title": "Song Name",
 *   "composer": "Composer Name",
 *   "key": "C",           // C, G, D, A, E, B, F#, C#, F, Bb, Eb, Ab, Db, Gb, Cb
 *   "time": "4/4",        // time signature
 *   "tempo": 120,         // BPM
 *   "measures": [
 *     {
 *       "treble": ["C4/q/1", "D4/q/2"],   // pitch/duration/fingering
 *       "bass": ["C3/h/3", "G3/h/1"]
 *     }
 *   ]
 * }
 * 
 * Pitch format: NoteOctave (C4, F#5, Bb3)
 * Duration: w=whole, h=half, q=quarter, e=eighth, s=sixteenth, t=thirty-second,
 *           d=dotted (qd=quarter-dot)
 * Fingering: 1-5 (optional)
 *
 * Treble and bass are arrays of strings or objects for more control:
 * "C4/q/1" = C4 quarter note, finger 1
 * {pitch: "C4", duration: "q", finger: 1, chord: ["E4", "G4"]} = chord
 * {pitch: "C4", duration: "h", tie: true} = tie CONTINUATION: extends the
 *   immediately-preceding same-pitch note (playback lengthens the gate instead
 *   of re-striking; converters emit tie on the 2nd..nth piece of a split note)
 * {rest: true, duration: "q"} = rest
 *
 * Optional top-level expression fields (playback honours them; older files
 * without them keep working):
 *   "tempoMap": [{"beat": 12.5, "bpm": 73}, ...]   rubato tempo changes
 *   "pedal":    [{"start": 1.5, "end": 3.25}, ...] CC64 sustain-down spans (quarters)
 */

class ScoreJSON {
    /**
     * Convert compact JSON to MusicXML
     */
    static toMusicXMLLegacy(json) {
        const {
            title = 'Untitled',
            composer = 'Unknown',
            key = 'C',
            time = '4/4',
            tempo = 120,
            measures = []
        } = json;

        const [beats, beatType] = time.split('/').map(Number);
        const keyFifths = this.keyToFifths(key);
        
        // Calculate durations and pad measures for equal width
        const paddedMeasures = this.equalizeMeasureWidths(measures, beats);
        
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>${this.escapeXml(title)}</work-title></work>
  <identification>
    <creator type="composer">${this.escapeXml(composer)}</creator>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
`;

        paddedMeasures.forEach((measure, index) => {
            const measureNum = index + 1;
            xml += this.measureToXML(measure, measureNum, beats, beatType, keyFifths, tempo, index === 0);
        });

        xml += `  </part>
</score-partwise>`;

        return xml;
    }

    /**
     * Calculate total duration of notes in a staff
     */
    static calculateStaffDuration(notes) {
        return notes.reduce((total, note) => {
            if (typeof note === 'string') {
                return total + this.durationToDivisions(note.split('/')[1] || 'q');
            }
            // Chord members do not advance measure time.
            if (note && note.chord && Array.isArray(note.chord)) {
                // (server chord head: chord is an array of member pitches) — count head only
            }
            const dur = note && note.duration;
            if (typeof dur === 'number') return total + dur;
            if (typeof dur === 'string') return total + this.durationToDivisions(dur);
            return total + 4;
        }, 0);
    }

    /**
     * Equalize all measure widths by padding with invisible rests
     * Finds the measure with maximum duration and pads all others to match
     */
    static equalizeMeasureWidths(measures, beatsPerMeasure) {
        // Calculate max duration needed (based on time signature)
        const divisionsPerBeat = 4; // quarter note = 4 divisions
        const maxDuration = beatsPerMeasure * divisionsPerBeat;
        
        return measures.map(measure => {
            const trebleDuration = this.calculateStaffDuration(measure.treble || []);
            const bassDuration = this.calculateStaffDuration(measure.bass || []);
            
            // Create padded copies
            const paddedMeasure = {
                treble: [...(measure.treble || [])],
                bass: [...(measure.bass || [])]
            };
            
            // Pad treble if needed
            if (trebleDuration < maxDuration) {
                const needed = maxDuration - trebleDuration;
                // Add invisible rest (will be made invisible in XML generation)
                paddedMeasure.treble.push({ 
                    rest: true, 
                    duration: needed, 
                    type: this.durationToTypeFromValue(needed),
                    invisible: true 
                });
            }
            
            // Pad bass if needed  
            if (bassDuration < maxDuration) {
                const needed = maxDuration - bassDuration;
                paddedMeasure.bass.push({ 
                    rest: true, 
                    duration: needed, 
                    type: this.durationToTypeFromValue(needed),
                    invisible: true 
                });
            }
            
            return paddedMeasure;
        });
    }

    /**
     * Convert a single measure to MusicXML
     */
    static measureToXML(measure, measureNum, beats, beatType, keyFifths, tempo, isFirst) {
        let xml = `    <measure number="${measureNum}">\n`;
        
        // Attributes on first measure
        if (isFirst) {
            xml += `      <attributes>
        <divisions>4</divisions>
        <key><fifths>${keyFifths}</fifths></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
        <staves>2</staves>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome>
            <beat-unit>quarter</beat-unit>
            <per-minute>${tempo}</per-minute>
          </metronome>
        </direction-type>
        <sound tempo="${tempo}"/>
      </direction>
`;
        }

        // Process treble staff notes
        const trebleNotes = this.parseNotes(measure.treble || []);
        const bassNotes = this.parseNotes(measure.bass || []);
        
        // Calculate total duration for backup
        const trebleDuration = this.calculateTotalDuration(trebleNotes);
        const bassDuration = this.calculateTotalDuration(bassNotes);
        const maxDuration = Math.max(trebleDuration, bassDuration, beats * 4); // Ensure at least full measure
        
        // Add treble notes
        const trebleBeams = this.computeBeams(trebleNotes);
        trebleNotes.forEach((note, idx) => {
            xml += this.noteToXML(note, 1, trebleBeams[idx]);
        });
        
        // Backup to start of measure for bass staff
        xml += `      <backup><duration>${maxDuration}</duration></backup>
`;
        
        // Add bass notes
        const bassBeams = this.computeBeams(bassNotes);
        bassNotes.forEach((note, idx) => {
            xml += this.noteToXML(note, 2, bassBeams[idx]);
        });
        
        xml += `    </measure>
`;
        return xml;
    }

    /**
     * Parse note strings or objects into structured format.
     *
     * Two token shapes are supported and both are normalised to a uniform
     * internal note ({ pitch, duration: <divisions>, type, finger, rest,
     * tie, chordPitches, invisible }):
     *   - string : "C4/q/1"  (pitch/duration-code/finger)
     *   - object : { pitch:"C4", duration:"e", finger, chord:["E4","G4"], tie, rest }
     *              (the shape the MIDI/audio server returns) — `duration` is a
     *              DURATION CODE (w/h/q/e/s + optional 'd'), not divisions.
     * Chords are expanded inline: the chord member pitches follow the head note
     * as additional <note><chord/> entries with the same duration.
     */
    static parseNotes(notes) {
        const out = [];
        notes.forEach(note => {
            if (typeof note === 'string') {
                out.push(this.parseNoteString(note));
                return;
            }
            if (note && typeof note === 'object') {
                out.push(...this.normalizeNoteObject(note));
                return;
            }
            // Unknown token — emit a defensive quarter rest so timing stays sane.
            out.push({ rest: true, duration: 4, type: 'quarter' });
        });
        return out;
    }

    /**
     * Normalise a server-style object token into one or more internal notes.
     * Returns an array because a chord head expands into head + chord members.
     */
    static normalizeNoteObject(note) {
        // Already-normalised padding rests (from equalizeMeasureWidths) carry a
        // NUMERIC duration — pass them through untouched.
        if (note.rest && typeof note.duration === 'number') {
            return [{ rest: true, duration: note.duration,
                      type: note.type || this.durationToTypeFromValue(note.duration),
                      invisible: !!note.invisible }];
        }

        const durCode = typeof note.duration === 'string' ? note.duration : 'q';
        const divisions = typeof note.duration === 'number'
            ? note.duration
            : this.durationToDivisions(durCode);
        const type = typeof note.duration === 'string'
            ? this.durationToType(durCode.replace('d', ''))
            : this.durationToTypeFromValue(divisions);
        const dotted = typeof note.duration === 'string' && durCode.endsWith('d');

        // Rest token.
        if (note.rest) {
            return [{ rest: true, duration: divisions, type, dotted, invisible: !!note.invisible }];
        }

        const head = {
            pitch: note.pitch,
            duration: divisions,
            type,
            dotted,
            finger: note.finger != null ? parseInt(note.finger) : null,
            tie: note.tie || null
        };
        const result = [head];

        // Expand chord members (share duration/type, marked as <chord/>).
        if (Array.isArray(note.chord)) {
            note.chord.forEach(p => {
                if (!p) return;
                result.push({ pitch: p, duration: divisions, type, dotted, finger: null, tie: null, chord: true });
            });
        }
        return result;
    }

    /**
     * Parse compact note string: "C4/q/1" or "rest/q"
     */
    static parseNoteString(str) {
        if (str.startsWith('rest/')) {
            const duration = str.substring(5);
            return { rest: true, duration: this.durationToDivisions(duration), type: this.durationToType(duration.replace('d', '')), dotted: duration.endsWith('d') };
        }

        const parts = str.split('/');
        const pitch = parts[0];
        const duration = parts[1] || 'q';
        const finger = parts[2] ? parseInt(parts[2]) : null;

        return {
            pitch,
            duration: this.durationToDivisions(duration),
            finger,
            type: this.durationToType(duration.replace('d', '')),
            dotted: duration.endsWith('d')
        };
    }

    /**
     * Convert duration code to divisions (quarter = 4)
     */
    static durationToDivisions(dur) {
        const isDotted = dur.endsWith('d');
        const base = dur.replace('d', '');
        
        const divisions = {
            'w': 16,  // whole
            'h': 8,   // half
            'q': 4,   // quarter
            'e': 2,   // eighth
            's': 1,   // sixteenth
            't': 0.5  // thirty-second
        };

        let value = divisions[base] ?? 4;
        if (isDotted) value = value * 1.5;
        return value;
    }

    /**
     * Convert duration code to MusicXML type
     */
    static durationToType(dur) {
        const types = {
            'w': 'whole',
            'h': 'half',
            'q': 'quarter',
            'e': 'eighth',
            's': '16th',
            't': '32nd'
        };
        return types[dur] || 'quarter';
    }

    /**
     * Convert note object to MusicXML
     */
    static noteToXML(note, staff, beam) {
        const voice = staff === 1 ? 1 : 5;
        if (note.rest) {
            // Invisible rest for padding - use print-object="no" to hide it
            const invisible = note.invisible ? ' print-object="no"' : '';
            const dot = note.dotted ? '<dot/>' : '';
            return `      <note><rest${invisible}/><duration>${note.duration}</duration><voice>${voice}</voice><type>${note.type || this.durationToTypeFromValue(note.duration)}</type>${dot}<staff>${staff}</staff></note>
`;
        }

        const { step, octave, alter } = this.parsePitch(note.pitch);
        // <chord/> MUST precede <pitch> per the MusicXML DTD.
        let xml = `      <note>
${note.chord ? '        <chord/>\n' : ''}        <pitch>
          <step>${step}</step>${alter !== 0 ? `\n          <alter>${alter}</alter>` : ''}
          <octave>${octave}</octave>
        </pitch>
        <duration>${note.duration}</duration>
`;
        // Tie (sound) element(s) — must come before <voice>.
        const tieType = note.tie === 'start' ? 'start' : note.tie === 'stop' ? 'stop' : (note.tie === true ? 'start' : null);
        if (tieType === 'start') xml += `        <tie type="start"/>\n`;
        else if (tieType === 'stop') xml += `        <tie type="stop"/>\n`;

        xml += `        <voice>${voice}</voice>
        <type>${note.type}</type>
${note.dotted ? '        <dot/>\n' : ''}        <staff>${staff}</staff>
`;

        // Notations: tied (visual slur) + fingering.
        const notations = [];
        if (tieType === 'start') notations.push('<tied type="start"/>');
        else if (tieType === 'stop') notations.push('<tied type="stop"/>');
        if (note.finger) notations.push(`<technical><fingering>${note.finger}</fingering></technical>`);
        if (notations.length) {
            xml += `        <notations>${notations.join('')}</notations>
`;
        }

        if (beam) {
            xml += `        <beam number="1">${beam}</beam>
`;
        }

        xml += `      </note>
`;
        return xml;
    }

    static computeBeams(notes) {
        const beams = new Array(notes.length).fill(null);

        const isBeamable = (n) => {
            if (!n || n.rest || n.chord === true) return false;
            return n.duration === 2 || n.duration === 1;
        };

        let i = 0;
        while (i < notes.length) {
            if (!isBeamable(notes[i])) {
                i++;
                continue;
            }

            let j = i;
            while (j < notes.length && isBeamable(notes[j])) j++;

            const len = j - i;
            if (len >= 2) {
                beams[i] = 'begin';
                for (let k = i + 1; k < j - 1; k++) beams[k] = 'continue';
                beams[j - 1] = 'end';
            }

            i = j;
        }

        return beams;
    }

    static durationToTypeFromValue(duration) {
        if (duration >= 16) return 'whole';
        if (duration >= 8) return 'half';
        if (duration >= 4) return 'quarter';
        if (duration >= 2) return 'eighth';
        if (duration >= 1) return '16th';
        return '32nd';
    }

    /**
     * Parse pitch string (C4, F#5, Bb3) into components
     */
    static parsePitch(pitch) {
        const match = pitch.match(/^([A-G])(#|b)?(\d+)$/);
        if (!match) return { step: 'C', alter: 0, octave: 4 };
        
        const step = match[1];
        const accidental = match[2];
        const octave = parseInt(match[3]);
        
        let alter = 0;
        if (accidental === '#') alter = 1;
        if (accidental === 'b') alter = -1;
        
        return { step, alter, octave };
    }

    /**
     * Calculate total duration of notes in a measure
     */
    static calculateTotalDuration(notes) {
        // Chord members (note.chord === true) share the head's time — don't double-count.
        return notes.reduce((sum, note) => sum + (note.chord === true ? 0 : (note.duration || 4)), 0);
    }

    /**
     * Convert key name to fifths
     */
    static keyToFifths(key) {
        const keys = {
            'Cb': -7, 'Gb': -6, 'Db': -5, 'Ab': -4, 'Eb': -3, 'Bb': -2, 'F': -1,
            'C': 0,
            'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7
        };
        return keys[key] || 0;
    }

    /**
     * Escape XML special characters
     */
    static escapeXml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // ===== CONVENIENCE EXAMPLES =====
    
    static getExample(name) {
        const examples = {
            'twinkle': {
                title: "Twinkle Twinkle Little Star",
                composer: "Traditional",
                key: "C",
                time: "4/4",
                tempo: 72,
                measures: [
                    { treble: ["C4/q/1", "C4/q/1", "G4/q/4", "G4/q/4"], bass: ["C3/q/2", "C3/q/2", "C3/q/2", "C3/q/2"] },
                    { treble: ["A4/q/5", "A4/q/5", "G4/h/4"], bass: ["F3/q/1", "F3/q/1", "E3/h/2"] },
                    { treble: ["F4/q/4", "F4/q/4", "E4/q/3", "E4/q/3"], bass: ["D3/q/2", "D3/q/2", "C3/q/3", "C3/q/3"] },
                    { treble: ["D4/q/2", "D4/q/2", "C4/h/1"], bass: ["G2/q/4", "G2/q/4", "C3/h/3"] }
                ]
            },
            'c-major': {
                title: "C Major Scale",
                composer: "Exercise",
                key: "C",
                time: "4/4",
                tempo: 120,
                measures: [
                    { treble: ["C4/q/1", "D4/q/2", "E4/q/3", "F4/q/4"], bass: ["C3/q/3", "D3/q/2", "E3/q/1", "F3/q/2"] },
                    { treble: ["G4/q/5", "A4/q/4", "B4/q/3", "C5/q/2"], bass: ["G3/q/1", "A3/q/2", "B3/q/3", "C4/q/1"] },
                    { treble: ["C5/q/2", "B4/q/3", "A4/q/4", "G4/q/5"], bass: ["C4/q/1", "B3/q/2", "A3/q/3", "G3/q/1"] },
                    { treble: ["F4/q/4", "E4/q/3", "D4/q/2", "C4/q/1"], bass: ["F3/q/2", "E3/q/1", "D3/q/2", "C3/q/3"] }
                ]
            }
        };
        return examples[name];
    }

    /**
     * Quick converter - pass JSON, get XML
     */
    static convert(json) {
        if (typeof json === 'string') {
            json = JSON.parse(json);
        }
        return this.toMusicXML(json);
    }
}


// ---------------------------------------------------------------------------
// Faithful direct ScoreJSON -> MusicXML emitter (port of the server's
// scorejson_to_musicxml). Replaces the legacy implementation, which collapsed
// chords into sequential notes, lost dotted/whole durations and miscomputed
// the two-voice <backup> (independently measured at F1=0.03 vs a reference
// score; this emitter measures 0.95). Legacy kept as toMusicXMLLegacy.
// divisions = 8 per quarter so w/h/q/e/s + dotted are all integers.
// ---------------------------------------------------------------------------
ScoreJSON.toMusicXML = function (json) {
    const DIV = 8;
    const CODE_DIV = { w: 32, wd: 48, h: 16, hd: 24, q: 8, qd: 12, e: 4, ed: 6, s: 2, sd: 3, t: 1 };
    const CODE_TYPE = { w: 'whole', h: 'half', q: 'quarter', e: 'eighth', s: '16th', t: '32nd' };
    const PC = { 'C': ['C', 0], 'C#': ['C', 1], 'Db': ['D', -1], 'D': ['D', 0], 'D#': ['D', 1],
        'Eb': ['E', -1], 'E': ['E', 0], 'F': ['F', 0], 'F#': ['F', 1], 'Gb': ['G', -1],
        'G': ['G', 0], 'G#': ['G', 1], 'Ab': ['A', -1], 'A': ['A', 0], 'A#': ['A', 1],
        'Bb': ['B', -1], 'B': ['B', 0] };

    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const numToDiv = (n) => Math.max(1, Math.round(n * (DIV / 4)));   // legacy quarter=4 scale
    const divToType = (d) => d >= 32 ? 'whole' : d >= 16 ? 'half' : d >= 8 ? 'quarter' : d >= 4 ? 'eighth' : '16th';

    const norm = (tok) => {
        if (typeof tok === 'string') {
            const a = tok.split('/');
            if (a[0] === 'rest') return { rest: true, duration: a[1] || 'q' };
            return { pitch: a[0], duration: a[1] || 'q', finger: a[2] || null };
        }
        return tok || { rest: true, duration: 'q' };
    };

    const pitchXml = (name) => {
        const m = /^([A-G][#b]?)(-?\d+)$/.exec(String(name || ''));
        if (!m || !PC[m[1]]) return null;
        const sa = PC[m[1]];
        return '<step>' + sa[0] + '</step>' + (sa[1] ? '<alter>' + sa[1] + '</alter>' : '') + '<octave>' + m[2] + '</octave>';
    };

    const noteXml = (tokRaw, voice, staff) => {
        const tok = norm(tokRaw);
        let div, typ, dot;
        if (typeof tok.duration === 'number') {
            div = numToDiv(tok.duration); typ = divToType(div); dot = '';
        } else {
            const code = String(tok.duration || 'q');
            div = CODE_DIV[code] || 8;
            typ = CODE_TYPE[code[0]] || 'quarter';
            dot = code.endsWith('d') ? '<dot/>' : '';
        }
        if (tok.rest) {
            const inv = tok.invisible ? ' print-object="no"' : '';
            return '      <note' + inv + '><rest/><duration>' + div + '</duration><voice>' + voice + '</voice><type>' + typ + '</type>' + dot + '<staff>' + staff + '</staff></note>\n';
        }
        const pitches = [tok.pitch].concat(Array.isArray(tok.chord) ? tok.chord : []);
        let out = '';
        pitches.forEach((pn, i) => {
            const px = pitchXml(pn);
            if (!px) return;
            const chord = i > 0 ? '<chord/>' : '';
            const tie = (i === 0 && tok.tie) ? '<tie type="' + (tok.tie === 'stop' ? 'stop' : 'start') + '"/>' : '';
            const fing = (i === 0 && tok.finger) ? '<notations><technical><fingering>' + tok.finger + '</fingering></technical></notations>' : '';
            out += '      <note>' + chord + '<pitch>' + px + '</pitch><duration>' + div + '</duration>' + tie + '<voice>' + voice + '</voice><type>' + typ + '</type>' + dot + '<staff>' + staff + '</staff>' + fing + '</note>\n';
        });
        return out;
    };

    const title = json.title || 'Untitled';
    const composer = json.composer || 'Unknown';
    const time = json.time || '4/4';
    const tempo = Number(json.tempo) || 120;
    const measures = json.measures || [];
    const beatsNum = Number(time.split('/')[0]) || 4;
    const beatsDen = Number(time.split('/')[1]) || 4;
    const measureDiv = Math.round(beatsNum * (4 / beatsDen) * DIV);
    const fifths = this.keyToFifths ? this.keyToFifths(json.key || 'C') : 0;

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
        '<score-partwise version="3.1">\n' +
        '  <work><work-title>' + esc(title) + '</work-title></work>\n' +
        '  <identification><creator type="composer">' + esc(composer) + '</creator></identification>\n' +
        '  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n' +
        '  <part id="P1">\n';

    measures.forEach((m, idx) => {
        xml += '    <measure number="' + (idx + 1) + '">\n';
        if (idx === 0) {
            xml += '      <attributes><divisions>' + DIV + '</divisions><key><fifths>' + fifths + '</fifths></key>' +
                '<time><beats>' + beatsNum + '</beats><beat-type>' + beatsDen + '</beat-type></time>' +
                '<clef number="1"><sign>G</sign><line>2</line></clef>' +
                '<clef number="2"><sign>F</sign><line>4</line></clef><staves>2</staves></attributes>\n' +
                '      <direction placement="above"><direction-type><metronome>' +
                '<beat-unit>quarter</beat-unit><per-minute>' + tempo + '</per-minute></metronome>' +
                '</direction-type><sound tempo="' + tempo + '"/></direction>\n';
        }
        (m.treble || []).forEach((tok) => { xml += noteXml(tok, 1, 1); });
        xml += '      <backup><duration>' + measureDiv + '</duration></backup>\n';
        (m.bass || []).forEach((tok) => { xml += noteXml(tok, 2, 2); });
        xml += '    </measure>\n';
    });

    xml += '  </part>\n</score-partwise>';
    return xml;
};

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ScoreJSON;
}
