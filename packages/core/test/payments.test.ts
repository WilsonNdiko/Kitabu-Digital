import { describe, it, expect } from 'vitest';
import {
  canTransition, assertPaymentTransition, initialPaymentStatus,
  canVerifyPayments, looksLikeMpesaRef,
} from '../src/payments.js';

describe('payment state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('PENDING', 'VERIFIED')).toBe(true);
    expect(canTransition('PENDING', 'REJECTED')).toBe(true);
    expect(canTransition('VERIFYING', 'VERIFIED')).toBe(true);
    expect(canTransition('VERIFIED', 'REVERSED')).toBe(true);
  });

  it('blocks arbitrary state manipulation', () => {
    expect(canTransition('VERIFIED', 'PENDING')).toBe(false);
    expect(canTransition('REVERSED', 'VERIFIED')).toBe(false);
    expect(canTransition('REJECTED', 'VERIFIED')).toBe(false);
    expect(canTransition('PENDING', 'REVERSED')).toBe(false);
    expect(() => assertPaymentTransition('VERIFIED', 'PENDING')).toThrow(/cannot/);
  });

  it('never auto-trusts an M-Pesa reference: always PENDING at entry', () => {
    expect(initialPaymentStatus('MPESA', 'OWNER')).toBe('PENDING');
    expect(initialPaymentStatus('MPESA', 'CARETAKER')).toBe('PENDING');
    expect(initialPaymentStatus('BANK', 'MANAGER')).toBe('PENDING');
  });

  it('cash held by owner/manager is verified at entry; caretaker cash is not', () => {
    expect(initialPaymentStatus('CASH', 'OWNER')).toBe('VERIFIED');
    expect(initialPaymentStatus('CASH', 'MANAGER')).toBe('VERIFIED');
    expect(initialPaymentStatus('CASH', 'CARETAKER')).toBe('PENDING');
  });

  it('only owners/managers verify', () => {
    expect(canVerifyPayments('OWNER')).toBe(true);
    expect(canVerifyPayments('MANAGER')).toBe(true);
    expect(canVerifyPayments('CARETAKER')).toBe(false);
  });

  it('M-Pesa reference shape check', () => {
    expect(looksLikeMpesaRef('SFR8K2L9QX')).toBe(true);
    expect(looksLikeMpesaRef('sfr8k2l9qx')).toBe(true);
    expect(looksLikeMpesaRef('ABC123')).toBe(false);
    expect(looksLikeMpesaRef('HELLO WORLD')).toBe(false);
  });
});
