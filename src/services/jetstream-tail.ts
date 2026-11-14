import {
  DeliverPolicy,
  type Consumer,
  type ConsumerMessages,
  type JetStreamManager,
  type JsMsg,
} from 'nats.ws';

/**
 * How long the broker keeps a consumer nobody pulls from. nats.ws takes
 * MILLISECONDS here and converts to the nanoseconds of the JetStream API
 * itself. This is the backstop for a page that vanishes without cleaning up
 * (crash, lost network, suspended phone); an orderly stop deletes the
 * consumer at once. Consumers the library re-creates after a reset get its
 * own default of 5 minutes.
 */
const CONSUMER_INACTIVE_THRESHOLD_MS = 60_000;

/**
 * One subject pattern of a JetStream stream, followed from its current state:
 * the last message per subject first, then every new message, in order.
 *
 * Backed by an ordered consumer, which the library re-creates from the last
 * seen sequence whenever the broker loses it — a reconnect after the consumer
 * expired, a broker restart, an admin cleanup. The tail therefore survives
 * outages of any length without loss or duplicates, and at any time owns at
 * most one consumer on the broker.
 */
export class JetStreamTail {
  private consumer: Consumer | null = null;
  private messages: ConsumerMessages | null = null;
  private stopped = false;
  private readonly finished: Promise<void>;

  constructor(
    jsm: JetStreamManager,
    private readonly pattern: string,
    onMessage: (m: JsMsg) => void,
  ) {
    this.finished = this.run(jsm, onMessage);
  }

  /**
   * Ends the tail and deletes its consumer on the broker. The delete request
   * is issued before the first await, so a `pagehide` handler that cannot
   * wait still hands it to the socket; should the browser drop it, the
   * inactive threshold removes the consumer.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.release();
    await this.finished;
  }

  private async run(jsm: JetStreamManager, onMessage: (m: JsMsg) => void): Promise<void> {
    try {
      const stream = await jsm.streams.find(this.pattern);
      if (this.stopped) return;
      this.consumer = await jsm.jetstream().consumers.get(stream, {
        filterSubjects: this.pattern,
        deliver_policy: DeliverPolicy.LastPerSubject,
        inactive_threshold: CONSUMER_INACTIVE_THRESHOLD_MS,
      });
      if (this.stopped) return;
      // The consumer is created on the broker here.
      this.messages = await this.consumer.consume();
      if (this.stopped) {
        await this.release();
        return;
      }
      for await (const m of this.messages) onMessage(m);
    } catch (err) {
      // Outages are recovered by the consumer itself; what arrives here is
      // final (no stream stores the subject, JetStream is off), so the tail
      // is dead until the next connect.
      if (!this.stopped) console.error('[nats] JetStream tail stopped', this.pattern, err);
    }
  }

  private async release(): Promise<void> {
    // Close first: a consumer deleted under a live iterator would be re-created.
    const closing = this.messages?.close();
    const deleting = this.consumer?.delete();
    await Promise.allSettled([closing, deleting]);
  }
}
