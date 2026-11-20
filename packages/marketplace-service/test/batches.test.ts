import { BatchId } from '@ethersphere/bee-js';
import { BatchManager, type BatchBee } from '../src/batches.js';
import { Store } from '../src/db.js';

const BATCH = 'ba'.repeat(32);
const OPTIONS = { sizeMb: 1, ttlDays: 30, retryAfterSeconds: 60 };

type FakeBee = BatchBee & { buyStorage: jest.Mock; getPostageBatch: jest.Mock };

function fakeBee(overrides: { buyStorage?: jest.Mock; getPostageBatch?: jest.Mock } = {}): FakeBee {
  return {
    buyStorage: jest.fn(async () => new BatchId(BATCH)),
    getPostageBatch: jest.fn(async () => ({ usable: false })),
    ...overrides,
  };
}

describe('BatchManager', () => {
  it('buys an immutable batch on the first request and asks the caller to retry', async () => {
    const bee = fakeBee();
    const store = new Store(':memory:');
    const manager = new BatchManager(bee, store, OPTIONS);

    expect(await manager.usableBatch(42n)).toEqual({ retryAfter: 60 });
    await manager.idle();

    expect(bee.buyStorage).toHaveBeenCalledTimes(1);
    expect(bee.buyStorage.mock.calls[0][2]).toMatchObject({
      immutableFlag: true,
      waitForUsable: false,
    });
    expect(store.getBatch('42')).toMatchObject({ batchId: BATCH, status: 'pending' });
  });

  it('does not buy twice while a purchase is in flight', async () => {
    let finish: (id: BatchId) => void = () => undefined;
    const bee = fakeBee({ buyStorage: jest.fn(() => new Promise<BatchId>((r) => (finish = r))) });
    const manager = new BatchManager(bee, new Store(':memory:'), OPTIONS);

    await manager.usableBatch(42n);
    await manager.usableBatch(42n);
    expect(bee.buyStorage).toHaveBeenCalledTimes(1);
    finish(new BatchId(BATCH));
    await manager.idle();
  });

  it('keeps one batch per seller', async () => {
    const bee = fakeBee();
    const manager = new BatchManager(bee, new Store(':memory:'), OPTIONS);
    await manager.usableBatch(1n);
    await manager.usableBatch(2n);
    await manager.idle();
    expect(bee.buyStorage).toHaveBeenCalledTimes(2);
  });

  it('returns the batch once Bee reports it usable, then without asking again', async () => {
    const bee = fakeBee();
    const manager = new BatchManager(bee, new Store(':memory:'), OPTIONS);
    await manager.usableBatch(42n);
    await manager.idle();

    expect(await manager.usableBatch(42n)).toEqual({ retryAfter: 60 }); // not usable yet
    bee.getPostageBatch.mockResolvedValue({ usable: true });
    expect(await manager.usableBatch(42n)).toEqual({ batchId: BATCH });
    expect(await manager.usableBatch(42n)).toEqual({ batchId: BATCH });
    expect(bee.getPostageBatch).toHaveBeenCalledTimes(2);
  });

  it('records a failed purchase and retries it on the next request', async () => {
    const bee = fakeBee({ buyStorage: jest.fn().mockRejectedValueOnce(new Error('no funds')) });
    bee.buyStorage.mockResolvedValue(new BatchId(BATCH));
    const store = new Store(':memory:');
    const manager = new BatchManager(bee, store, OPTIONS);

    await manager.usableBatch(42n);
    await manager.idle();
    expect(store.getBatch('42')).toMatchObject({ status: 'failed', error: 'no funds' });

    await manager.usableBatch(42n);
    await manager.idle();
    expect(store.getBatch('42')).toMatchObject({ status: 'pending', batchId: BATCH });
  });
});
