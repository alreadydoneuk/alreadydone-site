import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SOCIAL_URLS = {
  instagram: h => `https://instagram.com/${h.replace(/^@/, '')}`,
  twitter:   h => `https://x.com/${h.replace(/^@/, '')}`,
  x:         h => `https://x.com/${h.replace(/^@/, '')}`,
  tiktok:    h => `https://tiktok.com/@${h.replace(/^@/, '')}`,
  facebook:  h => `https://facebook.com/${h.replace(/^@/, '')}`,
  linkedin:  h => `https://linkedin.com/in/${h.replace(/^@/, '')}`,
  youtube:   h => `https://youtube.com/@${h.replace(/^@/, '')}`,
  github:    h => `https://github.com/${h.replace(/^@/, '')}`,
  behance:   h => `https://behance.net/${h.replace(/^@/, '')}`,
  pinterest: h => `https://pinterest.com/${h.replace(/^@/, '')}`,
  website:   h => h.startsWith('http') ? h : `https://${h}`,
};

const SOCIAL_ICONS = {
  instagram: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`,
  twitter:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  x:         `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  tiktok:    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34l-.01-8.83a8.18 8.18 0 0 0 4.78 1.52V4.56a4.85 4.85 0 0 1-1-.13z"/></svg>`,
  facebook:  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
  linkedin:  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
  youtube:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
  github:    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
  behance:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6.938 4.503c.702 0 1.34.06 1.92.188.577.13 1.07.33 1.485.61.41.28.733.65.96 1.12.225.47.34 1.05.34 1.73 0 .74-.17 1.36-.507 1.86-.338.5-.837.9-1.502 1.22.906.26 1.576.72 2.022 1.37.448.65.673 1.43.673 2.35 0 .74-.14 1.38-.42 1.96-.28.57-.67 1.05-1.16 1.43-.49.38-1.065.67-1.72.87-.655.2-1.35.3-2.07.3H0V4.51h6.938v-.007zM16.94 6.4h6.397v1.66H16.94V6.4zm-10.002.68H3.56v3.48h3.17c.69 0 1.24-.17 1.66-.5.42-.33.63-.84.63-1.53 0-.72-.21-1.23-.63-1.54-.42-.31-.97-.46-1.66-.46v.54h.21zm.2 5.55H3.56v4.1h3.6c.37 0 .72-.04 1.05-.12.33-.08.62-.21.87-.4.25-.19.44-.44.58-.75.14-.31.21-.69.21-1.14 0-.89-.25-1.52-.75-1.9-.5-.38-1.14-.57-1.92-.57l-.27.78h-.01zm12.07-4.25c.83 0 1.56.15 2.18.46.62.31 1.12.73 1.52 1.27.4.54.69 1.18.88 1.93.19.75.27 1.56.25 2.44H16.8c.04.88.32 1.56.84 2.04.52.48 1.24.72 2.14.72.64 0 1.2-.16 1.67-.48.47-.32.76-.66.87-1.02h3.18c-.5 1.55-1.26 2.67-2.27 3.35-1.01.68-2.25 1.02-3.69 1.02-1.01 0-1.92-.16-2.73-.48-.81-.32-1.49-.77-2.05-1.36-.56-.59-.99-1.3-1.28-2.12-.3-.82-.45-1.73-.45-2.72 0-.97.16-1.87.47-2.7.31-.83.75-1.54 1.32-2.13.57-.59 1.25-1.05 2.04-1.38.79-.33 1.67-.5 2.64-.5zm.06 2.26c-.74 0-1.34.2-1.79.6-.45.4-.72 1-.82 1.79h5.04c-.07-.8-.33-1.41-.78-1.81-.45-.4-1.01-.6-1.65-.58z"/></svg>`,
  website:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
};

export function resolveSocialUrl(platform, handle) {
  const fn = SOCIAL_URLS[platform.toLowerCase()];
  if (!fn) return handle.startsWith('http') ? handle : `https://${handle}`;
  return fn(handle);
}

export function getSocialIcon(platform) {
  return SOCIAL_ICONS[platform.toLowerCase()] || SOCIAL_ICONS.website;
}

export async function generateBusinessCard({ name, phone, socials = [], tone, domain, email }) {
  const resolvedSocials = socials.map(s => ({
    platform: s.platform,
    handle: s.handle,
    url: resolveSocialUrl(s.platform, s.handle),
    icon: getSocialIcon(s.platform),
  }));

  const socialsDesc = resolvedSocials.length
    ? resolvedSocials.map(s => `${s.platform}: ${s.handle}`).join(', ')
    : 'none';

  const prompt = `Generate a stunning, complete, self-contained one-page personal business card website as a single HTML file.

Person details:
- Name: ${name}
- Phone: ${phone || 'none — omit the phone section'}
- Email: ${email || 'none — omit the email section'}
- Socials: ${socialsDesc}
- Domain: ${domain}
- Visual tone / vibe: "${tone}"

Design requirements:
1. Single HTML file with all CSS embedded in <style> tags. No external dependencies except Google Fonts via @import.
2. Fully responsive — perfect on both mobile and desktop.
3. The TONE drives every visual decision: typography, color palette, spacing, animation style, mood.
4. Social links are real anchor tags pointing to the correct platform URLs (provided below).
5. Phone uses a tel: link. Email uses a mailto: link.
6. No contact form — this is a pure digital business card.
7. Add tasteful CSS-only animations that fit the tone.
8. The layout should feel considered and premium — this is a personal brand page, not a template.
9. Use semantic HTML.
10. Small print: © 2026 ${name}

Tone interpretation (apply creatively, don't be literal):
- "bright and fun" / "playful": warm pastel gradients, rounded corners, playful hover effects, friendly rounded fonts
- "dark" / "gothic" / "moody": near-black background, deep jewel accent colors or crimson, Playfair Display or similar serif, dramatic shadows, atmospheric
- "minimal" / "clean" / "professional": white or off-white, generous negative space, geometric sans-serif, thin borders, restrained
- "bold" / "striking" / "confident": high contrast, oversized type, strong geometric layout
- "creative" / "artistic": unconventional layout, mixed type scales, unexpected color combos
- Any other tone: interpret it genuinely and run with it

Social links to use (use exactly these URLs):
${resolvedSocials.map(s => `- ${s.platform}: ${s.url}`).join('\n') || '(none)'}

Return ONLY the complete HTML document starting with <!DOCTYPE html>. No markdown, no explanation.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  let html = message.content[0].text.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  }
  return html;
}
