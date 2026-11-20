import { Wallet } from 'ethers';
import { loadConfig, parseChainId, parseSplitterTerms, parseValueFloor } from '../src/config.js';

const token = Wallet.createRandom().address;
const factory = Wallet.createRandom().address;

describe('config parsing', () => {
  it('parses CAIP-2 networks', () => {
    expect(parseChainId('eip155:84532')).toBe(84532n);
    expect(() => parseChainId('84532')).toThrow();
  });

  it('parses splitter terms and value floors', () => {
    const treasury = Wallet.createRandom().address;
    expect(parseSplitterTerms(`${treasury.toLowerCase()}:500`)).toEqual([
      { treasury, taxBps: 500 },
    ]);
    expect(() => parseSplitterTerms(`${treasury}:20001`)).toThrow('taxBps');
    expect(parseValueFloor(`${token}:1000, ${factory}:5`)).toEqual([
      { asset: token, amount: 1000n },
      { asset: factory, amount: 5n },
    ]);
    expect(() => parseValueFloor(`${token}:1.5`)).toThrow('amount');
  });
});

describe('loadConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('requires the factory and accepted assets — no marketplace value has a default', () => {
    process.env = { ...saved, ACCEPTED_ASSETS: token };
    delete process.env.SPLITTER_FACTORY_ADDRESS;
    expect(() => loadConfig()).toThrow('SPLITTER_FACTORY_ADDRESS');

    process.env = { ...saved, SPLITTER_FACTORY_ADDRESS: factory };
    delete process.env.ACCEPTED_ASSETS;
    expect(() => loadConfig()).toThrow('ACCEPTED_ASSETS');
  });

  it('applies defaults and derives the envelope quota from the chunk cap', () => {
    process.env = {
      ...saved,
      SPLITTER_FACTORY_ADDRESS: factory,
      ACCEPTED_ASSETS: token,
      MAX_CHUNKS_PER_REQUEST: '8',
    };
    for (const key of ['MAX_ENVELOPES_PER_PURCHASE', 'SPLITTER_TERMS', 'VALUE_FLOOR', 'NETWORK']) {
      delete process.env[key];
    }
    const config = loadConfig();
    expect(config.chainId).toBe(84532n);
    expect(config.maxEnvelopesPerPurchase).toBe(32);
    expect(config.splitterTerms).toBeUndefined(); // read from the factory at startup
    expect(config.valueFloor).toEqual([]);
    expect(config.acceptedAssets).toEqual([token]);
  });

  it('rejects an inverted score range', () => {
    process.env = {
      ...saved,
      SPLITTER_FACTORY_ADDRESS: factory,
      ACCEPTED_ASSETS: token,
      SCORE_MIN: '10',
      SCORE_MAX: '5',
    };
    expect(() => loadConfig()).toThrow('SCORE_MIN');
  });
});
