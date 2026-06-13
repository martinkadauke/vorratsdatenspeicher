import nodemailer from 'nodemailer';
import { getConfig } from './config.js';

export async function smtpConfigured(): Promise<boolean> {
  const host = await getConfig('smtp.host');
  return !!host;
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const host = await getConfig('smtp.host');
  if (!host) throw new Error('SMTP ist nicht konfiguriert (Admin → SMTP)');
  const port = await getConfig('smtp.port');
  const secure = await getConfig('smtp.secure');
  const user = await getConfig('smtp.user');
  const pass = await getConfig('smtp.pass');
  const from = await getConfig('smtp.from');

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });

  await transporter.sendMail({ from, to, subject, text, ...(html ? { html } : {}) });
}
