// src/config/constants/messages/en/connect-telegram.ts
// Telegram-account connection flow (invitation delivery setup) messages.

export const enConnectTelegram = {
  connectTelegram: {
    consent: [
      '🔐 Connect Telegram Account',
      '',
      'This lets the bot send meeting invitations on your behalf',
      "to people who haven't started the bot yet.",
      '',
      '🔒 Security:',
      '• Session data is encrypted with AES-256-GCM',
      '• The encryption key lives only in the bot process memory — it is not stored on disk next to the data',
      '• The bot stores a technical session — no passwords, no messages',
      '',
      'The bot will NOT:',
      '• Read your messages',
      '• Send messages without your command',
      '• Access your contacts',
      '',
      'The bot WILL:',
      '• Send meeting invitations on your behalf',
      '',
      'You can disconnect anytime in /settings.',
    ].join('\n'),
    btnConnect: 'Connect',
    btnCancel: 'Cancel',
    btnSharePhone: '📱 Share phone number',
    enterPhone: 'Enter phone number in international format:\nExample: +79001234567',
    invalidPhone: 'Invalid format. Use international format: +79001234567',
    sendingCode: '⏳ Sending verification code…',
    codeSent: 'Verification code sent to Telegram.\nEnter the code with spaces or dashes (e.g. 1 2 3 4 5 or 123-45):',
    invalidCode: 'Invalid code. Enter 5 digits with spaces or dashes (e.g. 1 2 3 4 5 or 123-45).',
    btnCancelAuth: 'Cancel authorization',
    authCancelled: 'Authorization cancelled.',
    codeExpired: 'Code expired. Start over: /connect_telegram',
    wizardExpired:
      'The Telegram connection timed out. Your message was deleted in case it held a code or password. Start over: /connect_telegram',
    tooManyAttempts: 'Too many failed attempts. Start over: /connect_telegram',
    enter2fa: 'You have two-factor authentication enabled.\nEnter your password (it will not be stored):',
    invalid2fa: 'Wrong password. Try again.',
    success: (masked: string) =>
      `✅ Telegram account connected (${masked})\n\nInvitations will now be sent from your account.\nDisconnect: /settings`,
    cancelled: 'Connection cancelled.',
    featureUnavailable: 'Feature temporarily unavailable.',
    phoneAlreadyUsed: 'This phone number is already connected to another account.',
    floodWait: (minutes: number) => `Telegram rate-limited. Try again in ${minutes} min.`,
    alreadyConnected: (masked: string) => `✅ Telegram account already connected (${masked})\nReconnect?`,
    btnReconnect: 'Reconnect',
    cooldown: (seconds: number) => `Please wait ${seconds}s before retrying.`,
    successWithPending: (masked: string, eventTitle: string, dateLine: string, inviteeList: string) =>
      `✅ Telegram account connected (${masked})\n\nYou have a meeting "${eventTitle}" (${dateLine})\n\nNot yet invited:\n${inviteeList}`,
    sendPendingBtn: (count: number) => `Send ${count} invitation${count > 1 ? 's' : ''}`,
    skipPendingBtn: 'Not now',
    pendingSent: (count: number) => `✅ ${count} invitation${count > 1 ? 's' : ''} sent.`,
    tzDetected: (region: string, iana: string) => `It looks like you're now in ${region}.\nUpdate timezone to ${iana}?`,
    tzUpdated: (iana: string) => `✅ Timezone updated to ${iana}`,
    tzSkipped: 'Timezone not changed.',
    tzConsentPrompt:
      '🌍 The bot can detect your timezone from your Telegram session so events show at the correct local time.\nAllow? (only country/region is read, not messages)',
    tzConsentYes: 'Allow',
    tzConsentNo: 'No',
    accountUnavailable:
      'Telegram reports that the connected account is deactivated or unavailable. Check that account in Telegram first; reconnect here after access is restored.',
    revocationConfirmed:
      'Telegram reported that this connected session was revoked. The exact revocation time and who did it are not available.',
    connectionUnavailable:
      'Your Telegram connection is no longer available. Reconnect it to resume sending from your account.',
    lossObservedAt: (at: string) => `Detected at ${at} (UTC); this is the detection time, not the revocation time.`,
    sessionExpired:
      'I cannot send invitations from your account while disconnected. Calendar operations and messages from the bot remain available; some recipients may require a manually forwarded invitation link. Restore personal sending with /connect_telegram.',
    privateOnly: 'This command works only in private messages. Send /connect_telegram to me directly.',
  },
} as const;
