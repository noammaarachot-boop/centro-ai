// Simplified, illustrative brand marks for the onboarding Connections
// step — own inline vector art (not copies of either company's official
// asset files), close enough to read instantly as "Google Drive" /
// "WhatsApp" in a connection-status row.
export function GoogleDriveMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 22) / 24} viewBox="0 0 24 22" role="img" aria-label="Google Drive">
      <polygon points="8.6,1 15.4,1 22,12.5 15.4,12.5" fill="#FFC107" />
      <polygon points="2,21 5.4,15 19,15 15.6,21" fill="#1A73E8" />
      <polygon points="8.6,1 2,12.5 5.4,18.5 12,7" fill="#4CAF50" />
    </svg>
  );
}

export function WhatsAppMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="WhatsApp Business">
      <circle cx="12" cy="12" r="11" fill="#25D366" />
      <path
        d="M12 5.5a6.5 6.5 0 0 0-5.6 9.8L5.5 18.5l3.3-.9A6.5 6.5 0 1 0 12 5.5z"
        fill="none"
        stroke="white"
        strokeWidth="1.3"
      />
      <path
        d="M9.3 9.4c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .5.4.2.5.6 1.4.6 1.5.1.1.1.3 0 .4-.1.2-.2.3-.3.4-.1.2-.3.3-.1.6.2.4.9 1.4 1.9 1.8.3.1.5.1.6-.1.2-.2.5-.6.7-.8.2-.2.3-.2.5-.1.2.1 1.2.6 1.4.7.2.1.3.2.4.3 0 .2 0 .8-.2 1.2-.3.5-1.2.9-1.7.9-.5 0-1.7-.2-3.1-1.4-1.7-1.4-2.8-3.2-2.9-3.4-.1-.1-.9-1.2-.9-2.3 0-1.1.5-1.6.7-1.8z"
        fill="white"
      />
    </svg>
  );
}
