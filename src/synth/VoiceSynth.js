import CutoffSawtooth from './sources/CutoffSawtooth'
import RosenbergC from "./sources/RosenbergC"
import LiljencrantsFant from "./sources/LiljencrantsFant"
import KLGLOTT88 from "./sources/KLGLOTT88"
import synthPresets from "../presets"
import {db2amp} from '../gainConversion'

window.AudioContext = window.AudioContext || window.webkitAudioContext;

class VoiceSynth {

  static callbackDelay = 0.01;

  constructor() {
    this.sources = {
      'cutoffSawtooth': new CutoffSawtooth(),
      'rosenbergC': new RosenbergC(),
      'LF': new LiljencrantsFant(),
      'KLGLOTT88': new KLGLOTT88(),
    };
    this.loadPreset = this.loadPreset.bind(this);

    this.context = new AudioContext();
    this.sourceFilter = this.context.createBiquadFilter();
    this.breathFilter = this.context.createBiquadFilter();
    this.sourceGain = this.context.createGain();
    this.prefiltGain = this.context.createGain();
    this.zeroFilter = this.context.createBiquadFilter();
    this.amp = this.context.createGain();

    this.sourceFilter.type = 'lowpass';
    this.sourceFilter.frequency.setValueAtTime(10000, this.context.currentTime);

    this.breathFilter.type = 'lowpass';
    this.breathFilter.frequency.setValueAtTime(1500, this.context.currentTime);

    this.zeroFilter.type = 'bandpass';
    this.zeroFilter.frequency.setValueAtTime(1, this.context.currentTime);
    this.zeroFilter.Q.setValueAtTime(1, this.context.currentTime);

    this.zeroFilter.disconnect();

    this.sourceFilter.connect(this.sourceGain);
    this.breathFilter.connect(this.sourceGain);
    this.sourceGain.connect(this.prefiltGain);
    this.amp.connect(this.context.destination);

    this.volume = 1.0;
    this.playing = false;
    this.filterPass = true;

    this.formantF = [0, 0, 0, 0, 0];
    this._connectFilters();
  }

  start() {
    if (this.context.state === 'suspended') {
      this.context.resume();
    }

    this._setSource();

    this.source.start();
    this.breath.start();

    this.amp.gain.setValueAtTime(0, this.context.currentTime);
    this.amp.gain.linearRampToValueAtTime(this.volume, this.context.currentTime + 0.05);
    this.playing = true;
  }

  stop() {
    const time = this.context.currentTime + 0.1;

    this.source.stop(time);
    this.breath.stop(time);

    this.playing = false;
    this.amp.gain.linearRampToValueAtTime(0, time);
  }

  loadPreset(id, callback) {
    if (!id) {
      throw new Error('No preset name provided.');
    }

    const preset = synthPresets[id];

    this.frequency = preset.frequency;
    this.sourceName = preset.source.name;
    this.getSource().params = {...preset.source.params};
    this.formantF = [...preset.formants.freqs];
    this.formantBw = [...preset.formants.bands];
    this.formantGain = [...preset.formants.gains];

    this.sourceGain.gain.value = 0.2;
    this.prefiltGain.gain.value = 5;
    this.amp.gain.value = this.volume;
    this._setFilters(true);

    if (this.playing) {
      this.start();
    }

    if (callback) {
      setTimeout(() => callback(preset), VoiceSynth.callbackDelay / 1000);
    }
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.playing) {
      this.amp.gain.linearRampToValueAtTime(vol, this.context.currentTime + 0.01);
    }
  }

  setSource({frequency, name, params}) {
    if (frequency !== undefined) {
      this.frequency = frequency;
    }
    if (name !== undefined) {
      this.sourceName = name;
    }

    const source = this.getSource();

    if (params !== undefined) {
      Object.entries(params).forEach(([key, value]) => {
        if (key in source.params) {
          source.params[key] = value;
        } else {
          throw new Error(`Source parameter "${key}" does not exist.`)
        }
      });
    }

    if (this.playing) {
      this.start();
    }
  }

  getSource() {
    return this.sources[this.sourceName];
  }

  toggleFilters(flag) {
    this.filterPass = flag;
    this._setFilters(true);
  }

  setFormant(formants, callback) {
    const ii = [];

    for (const {i, frequency, gain, bandwidth} of formants) {
      if (frequency !== undefined) {
        this.formantF[i] = frequency;
      }
      if (gain !== undefined) {
        this.formantGain[i] = gain;
      }
      if (bandwidth !== undefined) {
        this.formantBw[i] = bandwidth;
      }

      ii.push(i);
    }

    this._setFilters(true, ii, callback);
  }

  _setSource() {
    const source = this.getSource();
    const buffer = source.getBuffer(this.context, this.frequency);

    // Transition fundamental frequency
    const time = this.context.currentTime + 0.05;

    const oldFrequency = this.source ? (this.context.sampleRate / this.source.buffer.length) : this.frequency;
    const detuneCents = 1200 * Math.log2(this.frequency / oldFrequency);

    if (this.source) {
      const node = this.source;
      node.onended = () => node.disconnect();
      node.stop(time);
      node.detune.linearRampToValueAtTime(detuneCents, time / 2);
    }

    if (this.breath) {
      const node = this.breath;
      node.onended = () => node.disconnect();
      node.stop(time);
      node.detune.linearRampToValueAtTime(detuneCents, time / 2);
    }

    this.source = this.context.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.source.connect(this.sourceFilter);

    const noiseBuffer = source.getNoiseBuffer(this.context, buffer);

    this.breath = this.context.createBufferSource();
    this.breath.buffer = noiseBuffer;
    this.breath.loop = true;
    this.breath.connect(this.breathFilter);
  }

  _connectFilters() {
    if (this.filters) {
      this.filters.forEach(flt => flt.disconnect());
    }
    if (this.filterGain) {
      this.filterGain.forEach(flt => flt.disconnect());
    }
    this.prefiltGain.disconnect();
    this.zeroFilter.disconnect();
    this.sourceGain.disconnect();

    const N = this.formantF.length;

    this.filterGain = new Array(N);
    this.filters = new Array(N);

    for (let i = 0; i < N; ++i) {
      this.filterGain[i] = this.context.createGain();
      this.filters[i] = this.context.createBiquadFilter();
      this.filters[i].type = 'bandpass';

      this.prefiltGain.connect(this.filters[i]);
      this.filters[i].connect(this.filterGain[i]);
      this.filterGain[i].connect(this.amp);
    }

    this.zeroFilter.connect(this.amp);
  }

  _setFilters(change, j, callback) {

    this.sourceGain.disconnect();

    if (this.filterPass) {
      for (let i = 0; i < this.filters.length; ++i) {
        if (change === true && (j === undefined || j === i || (Array.isArray(j) && j.includes(i)))) {
          const gainNode = this.filterGain[i];
          const filter = this.filters[i];

          const Fi = this.formantF[i];
          const Qi = Fi / this.formantBw[i];
          const Gi = db2amp(this.formantGain[i]);

          const time = this.context.currentTime + 0.005;

          filter.frequency.linearRampToValueAtTime(Fi, time);
          filter.Q.linearRampToValueAtTime(Qi, time);
          gainNode.gain.linearRampToValueAtTime(Gi, time);
        }
      }

      this.sourceGain.connect(this.prefiltGain);
    } else {
      this.sourceGain.connect(this.amp);
    }

    if (callback !== undefined) {
      setTimeout(callback, VoiceSynth.callbackDelay / 1000);
    }
  }

}

export default VoiceSynth;