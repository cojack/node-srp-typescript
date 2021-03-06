import crypto from 'crypto'
import BigNum from 'bignum'
import assert from 'assert'
import {params, SRPParams} from './params'

const zero: BigNum = new BigNum(0);

const assert_ = (val: boolean, msg: string) => {
  if(!val) {
    throw new Error(msg||"assertion");
  }
}

/*
 * If a conversion is explicitly specified with the operator PAD(),
 * the integer will first be implicitly converted, then the resultant
 * byte-string will be left-padded with zeros (if necessary) until its
 * length equals the implicitly-converted length of N.
 *
 * params:
 *         n (buffer)       Number to pad
 *         len (int)        length of the resulting Buffer
 *
 * returns: buffer
 */

const padTo = (n: Buffer, len: number): Buffer => {
  assertIsBuffer(n, "n");
  const padding = len - n.length;
  assert_(padding > -1, "Negative padding.  Very uncomfortable.");
  const result = new Buffer(len);
  result.fill(0, 0, padding);
  n.copy(result, padding);
  assert.strictEqual(result.length, len);
  return result;
}

const padToN = (number: BigNum, params: SRPParams): Buffer => {
  assertIsBigNum(number);
  return padTo(number.toBuffer(), params.N_length_bits/8);
}

const padToH = (number: BigNum, params: SRPParams): Buffer => {
  assertIsBigNum(number);
  let hashLenBits;
  if (params.hash === "sha256")
    hashLenBits = 256;
  else if (params.hash === "sha512")
    hashLenBits = 512;
  else
    throw Error("cannot determine length of hash '"+params.hash+"'");

  return padTo(number.toBuffer(), hashLenBits/8);
}

const assertIsBuffer = (arg: any, argname: string): void => {
  argname = argname || "arg";
  assert_(Buffer.isBuffer(arg), "Type error: "+argname+" must be a buffer");
}

const assertIsNBuffer = (arg: any, params: SRPParams, argname: string): void => {
  argname = argname || "arg";
  assert_(Buffer.isBuffer(arg), "Type error: "+argname+" must be a buffer");
  if (arg.length != params.N_length_bits/8)
    assert_(false, argname+" was "+arg.length+", expected "+(params.N_length_bits/8));
}

const assertIsBigNum = (arg: any): void => {
  assert.strictEqual(arg.constructor.name, "BigNum");
}

/*
 * compute the intermediate value x as a hash of three buffers:
 * salt, identity, and password.  And a colon.  FOUR buffers.
 *
 *      x = H(s | H(I | ":" | P))
 *
 * params:
 *         salt (buffer)    salt
 *         I (buffer)       user identity
 *         P (buffer)       user password
 *
 * returns: x (bignum)      user secret
 */
const getx = (params: SRPParams, salt: Buffer, I: Buffer, P: Buffer): BigNum => {
  assertIsBuffer(salt, "salt (salt)");
  assertIsBuffer(I, "identity (I)");
  assertIsBuffer(P, "password (P)");
  const hashIP = crypto.createHash(params.hash)
    .update(Buffer.concat([I, new Buffer(':'), P]))
    .digest();
  const hashX = crypto.createHash(params.hash)
    .update(salt)
    .update(hashIP)
    .digest();
  return BigNum.fromBuffer(hashX);
}

/*
 * The verifier is calculated as described in Section 3 of [SRP-RFC].
 * We give the algorithm here for convenience.
 *
 * The verifier (v) is computed based on the salt (s), user name (I),
 * password (P), and group parameters (N, g).
 *
 *         x = H(s | H(I | ":" | P))
 *         v = g^x % N
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         salt (buffer)    salt
 *         I (buffer)       user identity
 *         P (buffer)       user password
 *
 * returns: buffer
 */
const computeVerifier = (params: SRPParams, salt: Buffer, I: Buffer, P: Buffer): Buffer => {
  assertIsBuffer(salt, "salt (salt)");
  assertIsBuffer(I, "identity (I)");
  assertIsBuffer(P, "password (P)");
  const v_num = params.g.powm(getx(params, salt, I, P), params.N)
  return padToN(v_num, params);
}

/*
 * calculate the SRP-6 multiplier
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *
 * returns: bignum
 */
const getk = (params: SRPParams): BigNum => {
  const k_buf = crypto
    .createHash(params.hash)
    .update(padToN(params.N, params))
    .update(padToN(params.g, params))
    .digest();
  return BigNum.fromBuffer(k_buf);
}

/*
 * Generate a random key
 *
 * params:
 *         bytes (int)      length of key (default=32)
 *         callback (func)  function to call with err,key
 *
 * returns: nothing, but runs callback with a Buffer
 */
const genKey = (bytes: number, callback: Function): void => {
  if (typeof callback !== 'function') {
    throw("Callback required");
  }
  crypto.randomBytes(bytes, (err: Error | null, buf: Buffer) => {
    if (err) return callback (err)
    return callback(null, buf)
  })
}

/*
 * The server key exchange message also contains the server's public
 * value (B).  The server calculates this value as B = k*v + g^b % N,
 * where b is a random number that SHOULD be at least 256 bits in length
 * and k = H(N | PAD(g)).
 *
 * Note: as the tests imply, the entire expression is mod N.
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         v (bignum)       verifier (stored)
 *         b (bignum)       server secret exponent
 *
 * returns: B (buffer)      the server public message
 */
const getB = (params: SRPParams, k: BigNum, v: BigNum, b: BigNum): Buffer => {
  assertIsBigNum(v);
  assertIsBigNum(k);
  assertIsBigNum(b);
  const N = params.N;
  const r = k.mul(v).add(params.g.powm(b, N)).mod(N);
  return padToN(r, params);
}

/*
 * The client key exchange message carries the client's public value
 * (A).  The client calculates this value as A = g^a % N, where a is a
 * random number that SHOULD be at least 256 bits in length.
 *
 * Note: for this implementation, we take that to mean 256/8 bytes.
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         a (bignum)       client secret exponent
 *
 * returns A (bignum)       the client public message
 */
const getA = (params: SRPParams, a_num: BigNum) => {
  assertIsBigNum(a_num);
  if (Math.ceil(a_num.bitLength() / 8) < 256/8) {
    console.warn("getA: client key length", a_num.bitLength(), "is less than the recommended 256");
  }
  return padToN(params.g.powm(a_num, params.N), params);
}

/*
 * getu() hashes the two public messages together, to obtain a scrambling
 * parameter "u" which cannot be predicted by either party ahead of time.
 * This makes it safe to use the message ordering defined in the SRP-6a
 * paper, in which the server reveals their "B" value before the client
 * commits to their "A" value.
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         A (Buffer)       client ephemeral public key
 *         B (Buffer)       server ephemeral public key
 *
 * returns: u (bignum)      shared scrambling parameter
 */
const getu = (params: SRPParams, A: Buffer, B: Buffer): BigNum => {
  assertIsNBuffer(A, params, "A");
  assertIsNBuffer(B, params, "B");
  const u_buf = crypto.createHash(params.hash)
    .update(A).update(B)
    .digest()
  return BigNum.fromBuffer(u_buf);
}

/*
 * The TLS premaster secret as calculated by the client
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         salt (buffer)    salt (read from server)
 *         I (buffer)       user identity (read from user)
 *         P (buffer)       user password (read from user)
 *         a (bignum)       ephemeral private key (generated for session)
 *         B (bignum)       server ephemeral public key (read from server)
 *
 * returns: buffer
 */

const client_getS = (params: SRPParams, k_num: BigNum, x_num: BigNum, a_num: BigNum, B_num: BigNum, u_num: BigNum): Buffer => {
  assertIsBigNum(k_num);
  assertIsBigNum(x_num);
  assertIsBigNum(a_num);
  assertIsBigNum(B_num);
  assertIsBigNum(u_num);
  const g = params.g
  const N = params.N
  if (zero.ge(B_num) || N.le(B_num))
    throw new Error("invalid server-supplied 'B', must be 1..N-1");
  const S_num = B_num.sub(k_num.mul(g.powm(x_num, N))).powm(a_num.add(u_num.mul(x_num)), N).mod(N)
  return padToN(S_num, params);
}

/*
 * The TLS premastersecret as calculated by the server
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         v (bignum)       verifier (stored on server)
 *         A (bignum)       ephemeral client public key (read from client)
 *         b (bignum)       server ephemeral private key (generated for session)
 *
 * returns: bignum
 */

const server_getS = (params: SRPParams, v_num: BigNum, A_num: BigNum, b_num: BigNum, u_num: BigNum) => {
  assertIsBigNum(v_num);
  assertIsBigNum(A_num);
  assertIsBigNum(b_num);
  assertIsBigNum(u_num);
  const N = params.N
  if (zero.ge(A_num) || N.le(A_num))
    throw new Error("invalid client-supplied 'A', must be 1..N-1");
  const S_num = A_num.mul(v_num.powm(u_num, N)).powm(b_num, N).mod(N)
  return padToN(S_num, params);
}

/*
 * Compute the shared session key K from S
 *
 * params:
 *         params (obj)     group parameters, with .N, .g, .hash
 *         S (buffer)       Session key
 *
 * returns: buffer
 */
const getK = (params: SRPParams, S_buf: Buffer): Buffer => {
  assertIsNBuffer(S_buf, params, "S");
  return crypto.createHash(params.hash)
      .update(S_buf)
      .digest();
}

const getM1 = (params: SRPParams, A_buf: Buffer, B_buf: Buffer, S_buf: Buffer): Buffer => {
  assertIsNBuffer(A_buf, params, "A");
  assertIsNBuffer(B_buf, params, "B");
  assertIsNBuffer(S_buf, params, "S");
  return crypto.createHash(params.hash)
    .update(A_buf).update(B_buf).update(S_buf)
    .digest();
}

const getM2 = (params: SRPParams, A_buf: Buffer, M_buf: Buffer, K_buf: Buffer): Buffer => {
  assertIsNBuffer(A_buf, params, "A");
  assertIsBuffer(M_buf, "M");
  assertIsBuffer(K_buf, "K");
  return crypto.createHash(params.hash)
    .update(A_buf).update(M_buf).update(K_buf)
    .digest();
}

const equal = (buf1: Buffer, buf2: Buffer) => {
  // constant-time comparison. A drop in the ocean compared to our
  // non-constant-time modexp operations, but still good practice.
  let mismatch = buf1.length - buf2.length
  if (mismatch) {
    return false;
  }
  for (let i = 0; i < buf1.length; i++) {
    mismatch |= buf1[i] ^ buf2[i];
  }
  return mismatch === 0;
}

interface ClientPrivate {
  params: SRPParams,
  k_num: BigNum,
  x_num: BigNum,
  a_num: BigNum,
  A_buf: Buffer,
  M1_buf?: Buffer,
  M2_buf?: Buffer,
  K_buf?: Buffer,
  u_num?: BigNum,
  S_buf?: Buffer
}

export class Client {

  public readonly _private: ClientPrivate

  constructor(params: SRPParams, salt_buf: Buffer, identity_buf: Buffer, password_buf: Buffer, secret1_buf: Buffer) {
    assertIsBuffer(salt_buf, "salt (salt)")
    assertIsBuffer(identity_buf, "identity (I)")
    assertIsBuffer(password_buf, "password (P)")
    assertIsBuffer(secret1_buf, "secret1")
    const a_num: BigNum = BigNum.fromBuffer(secret1_buf)
    this._private = {
      params: params,
      k_num: getk(params),
      x_num: getx(params, salt_buf, identity_buf, password_buf),
      a_num: a_num,
      A_buf: getA(params, a_num)
    }
  }

  public computeA(): Buffer {
    return this._private.A_buf
  }

  public setB(B_buf: Buffer): void {
    let p: any = this._private as any
    const B_num: BigNum = BigNum.fromBuffer(B_buf)
    const u_num: BigNum = getu(p.params, p.A_buf, B_buf)
    const S_buf: Buffer = client_getS(p.params, p.k_num, p.x_num, p.a_num, B_num, u_num)
    p.K_buf = getK(p.params, S_buf);
    p.M1_buf = getM1(p.params, p.A_buf, B_buf, S_buf);
    p.M2_buf = getM2(p.params, p.A_buf, p.M1_buf, p.K_buf);
    p.u_num = u_num; // only for tests
    p.S_buf = S_buf; // only for tests
  }

  public computeM1() {
    if (this._private.M1_buf === undefined)
      throw new Error("incomplete protocol");
    return this._private.M1_buf;
  }

  public checkM2(serverM2_buf: Buffer) {
    if(!this._private.M2_buf || !equal(this._private.M2_buf, serverM2_buf))
      throw new Error("server is not authentic")
  }

  public computeK() {
    if(this._private.K_buf === undefined)
      throw new Error("incomplete protocol");
    return this._private.K_buf;
  }
}

interface ServerPrivate {
  params: SRPParams,
  k_num: BigNum,
  b_num: BigNum,
  v_num: BigNum,
  B_buf: Buffer,
  K_buf?: Buffer,
  M1_buf?: Buffer,
  M2_buf?: Buffer,
  u_num?: BigNum,
  S_buf?: Buffer
}

export class Server {

  public readonly _private: ServerPrivate

  constructor(params: SRPParams, verifier_buf: Buffer, secret2_buf: Buffer) {
    assertIsBuffer(verifier_buf, "verifier");
    assertIsBuffer(secret2_buf, "secret2");
    const k_num: BigNum = getk(params)
    const v_num: BigNum = BigNum.fromBuffer(verifier_buf)
    const b_num: BigNum = BigNum.fromBuffer(secret2_buf)
    this._private = {
      params: params,
      k_num: k_num,
      b_num: b_num,
      v_num: v_num,
      B_buf: getB(params, k_num, v_num, b_num),
    }
  }

  public computeB() {
    return this._private.B_buf;
  }

  public setA(A_buf: Buffer): void {
    let p = this._private
    const A_num: BigNum = BigNum.fromBuffer(A_buf)
    const u_num: BigNum = getu(p.params, A_buf, p.B_buf);
    const S_buf: Buffer = server_getS(p.params, p.v_num, A_num, p.b_num, u_num);
    p.K_buf = getK(p.params, S_buf);
    p.M1_buf = getM1(p.params, A_buf, p.B_buf, S_buf);
    p.M2_buf = getM2(p.params, A_buf, p.M1_buf, p.K_buf);
    p.u_num = u_num; // only for tests
    p.S_buf = S_buf; // only for tests
  }

  public checkM1(clientM1_buf: Buffer): Buffer | undefined {
    if (this._private.M1_buf === undefined)
      throw new Error("incomplete protocol");
    if (!equal(this._private.M1_buf, clientM1_buf))
      throw new Error("client did not use the same password");
    return this._private.M2_buf;
  }

  public computeK() {
    if (this._private.K_buf === undefined)
      throw new Error("incomplete protocol");
    return this._private.K_buf;
  }
}

export { computeVerifier, genKey, params }
