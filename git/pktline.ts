// git/pktline.ts: the pkt-line codec git's smart HTTP speaks.
//
//   <4 hex length><payload>   a data packet; the length counts the 4 header bytes
//   0000                      flush-pkt, ends a section
//   0001                      delim-pkt, separates the command block from its arguments (v2)
//   0002                      response-end-pkt
//
// The largest packet is 65520 bytes (LARGE_PACKET_MAX); the largest payload is 65516.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length header. */
export const PKT_LINE_MAX = 65520;
/** The largest payload one pkt-line can carry. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

/** One pkt-line: `data` its payload bytes, or a special packet with no payload. */
export type Packet =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Frame one data packet around `payload` (a string is encoded as UTF-8). */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload ${data.length} over ${PKT_LINE_MAX_PAYLOAD}`);
  }
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush-pkt: 0000. */
export const FLUSH = Buffer.from('0000', 'ascii');
/** The delim-pkt: 0001. */
export const DELIM = Buffer.from('0001', 'ascii');
/** The response-end-pkt: 0002. */
export const RESPONSE_END = Buffer.from('0002', 'ascii');

/** Frame a list of packets, each a string, a Buffer, or one of the constants above. */
export function pktLines(items: ReadonlyArray<string | Buffer>): Buffer {
  return Buffer.concat(items.map((item) => (Buffer.isBuffer(item) ? item : pkt(item))));
}

/** One decoded packet, with the exact bytes that framed it (`raw`, for raw-pack fallbacks). */
export interface DecodedPacket {
  packet: Packet;
  raw: Buffer;
  /** The payload's text form (empty for a special packet). */
  text: string;
}

/**
 * Decode the pkt-lines at the start of `buf`. Answers the packets read, how many bytes they used,
 * and whether the buffer simply ran out (`incomplete`) rather than holding something that is not a
 * pkt-line. A caller reading a stream keeps the remainder and tries again.
 */
export function decodePackets(buf: Buffer): { packets: DecodedPacket[]; used: number; incomplete: boolean } {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { packets, used: off, incomplete: false };
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ packet: { kind: 'flush' }, raw: buf.subarray(off, off + 4), text: '' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ packet: { kind: 'delim' }, raw: buf.subarray(off, off + 4), text: '' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ packet: { kind: 'response-end' }, raw: buf.subarray(off, off + 4), text: '' });
      off += 4;
      continue;
    }
    if (len < 4) return { packets, used: off, incomplete: false };
    if (off + len > buf.length) return { packets, used: off, incomplete: true };
    const data = buf.subarray(off + 4, off + len);
    packets.push({ packet: { kind: 'data', data }, raw: buf.subarray(off, off + len), text: data.toString('utf8') });
    off += len;
  }
  return { packets, used: off, incomplete: off < buf.length };
}

/** The data payloads of the packets, as text lines (special packets dropped). */
export function dataLines(packets: ReadonlyArray<DecodedPacket>): string[] {
  return packets.filter((p) => p.packet.kind === 'data').map((p) => p.text.replace(/\n$/, ''));
}
