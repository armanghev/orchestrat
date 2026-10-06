// Reuse the landing page's palette, system font stack, and public PNG logo.
// Inline styles and presentation tables keep the layout usable in email clients.
export const waitlistWelcomeEmail = {
  subject: "You're on the Orchestrat waitlist",
  text: [
    "Welcome to Orchestrat!",
    "You're on the list. Your place is saved.",
    "Less chasing. More building.",
    "We're building a shared workspace for coordinating AI coding agents. Tasks, context, and agent activity, in one shared workspace.",
    "We'll send you an invitation when early access is ready for your workspace.",
    "Explore Orchestrat: https://orchestrat.dev",
    "To leave the waitlist, email arman@orchestrat.dev.",
    "Orchestrat"
  ].join("\n\n"),
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>Welcome to Orchestrat</title>
    <style>
      @media only screen and (max-width: 480px) {
        .email-shell { padding: 16px 12px !important; }
        .email-content { padding: 28px 24px !important; }
        .email-heading { font-size: 36px !important; line-height: 40px !important; }
      }
    </style>
  </head>
  <body style="margin: 0; padding: 0; background-color: #1e1e1e; color: #eeeeee; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Arial, sans-serif; -webkit-text-size-adjust: 100%;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">Your place is saved. We'll be in touch when early access is ready.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#1e1e1e">
      <tr>
        <td class="email-shell" align="center" style="padding: 48px 20px;">
          <!--[if mso]><table role="presentation" width="560" align="center"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; border: 1px solid #3d3d3d; border-radius: 10px;">
            <tr>
              <td class="email-content" style="padding: 40px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="48" valign="middle">
                      <img src="https://orchestrat.dev/favicon-96x96.png" width="36" height="36" alt="Orchestrat logo" style="display: block; border: 0;" />
                    </td>
                    <td valign="middle" style="font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -0.6px; color: #eeeeee;">Orchestrat</td>
                  </tr>
                </table>
                <p style="margin: 44px 0 12px; color: #f39b3a; font-size: 13px; line-height: 20px; font-weight: 500;">Welcome to Orchestrat</p>
                <h1 class="email-heading" style="margin: 0 0 24px; color: #eeeeee; font-size: 44px; line-height: 48px; font-weight: 600; letter-spacing: -1.8px;">You're on the list.</h1>
                <p style="margin: 0 0 20px; color: #eeeeee; font-size: 16px; line-height: 26px;">Thanks for joining the waitlist. Your place is saved.</p>
                <p style="margin: 0 0 20px; color: #b0b0b0; font-size: 16px; line-height: 26px;">We're building a shared workspace for coordinating AI coding agents. Tasks, context, and agent activity, in one shared workspace.</p>
                <p style="margin: 0 0 28px; color: #b0b0b0; font-size: 16px; line-height: 26px;">We'll send you an invitation when early access is ready for your workspace.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#eeeeee" style="border-radius: 6px; text-align: center; mso-padding-alt: 14px 22px;">
                      <a href="https://orchestrat.dev" style="display: inline-block; padding: 14px 22px; border: 1px solid #eeeeee; border-radius: 6px; color: #1e1e1e; font-size: 14px; line-height: 20px; font-weight: 600; text-decoration: none;">Explore Orchestrat</a>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 36px;">
                  <tr>
                    <td style="border-top: 1px solid #3d3d3d; padding-top: 24px;">
                      <p style="margin: 0; color: #eeeeee; font-size: 16px; line-height: 24px; font-weight: 500;">Less chasing. <span style="color: #b0b0b0;">More building.</span></p>
                      <p style="margin: 8px 0 0; font-size: 13px; line-height: 20px;"><a href="https://orchestrat.dev" style="color: #b0b0b0; text-decoration: none;">orchestrat.dev</a></p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
          <p style="max-width: 480px; margin: 24px 0 0; color: #b0b0b0; font-size: 12px; line-height: 20px;">You're receiving this because you joined the Orchestrat waitlist.<br /><a href="mailto:arman@orchestrat.dev?subject=Remove%20me%20from%20the%20waitlist" style="color: #b0b0b0; text-decoration: underline;">Leave the waitlist</a>&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="https://orchestrat.dev/privacy" style="color: #b0b0b0; text-decoration: underline;">Privacy</a></p>
        </td>
      </tr>
    </table>
  </body>
</html>`
};
