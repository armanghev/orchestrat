"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Analytics } from "@vercel/analytics/next";
import {
  consentedEvent,
  consentStorageKey,
  readConsent,
  type AnalyticsConsent
} from "@/lib/consent";

export function CookiePreferences() {
  const [consent, setConsent] = useState<AnalyticsConsent>(null);
  const [open, setOpen] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const currentConsent = useRef<AnalyticsConsent>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const banner = useRef<HTMLElement>(null);
  const reopened = useRef(false);

  useEffect(() => {
    function syncConsent() {
      const saved = readConsent();
      currentConsent.current = saved;
      setConsent(saved);
      setOpen(saved === null);
    }
    function onStorage(event: StorageEvent) {
      if (event.key === consentStorageKey || event.key === null) syncConsent();
    }
    syncConsent();
    window.addEventListener("storage", onStorage);
    return () => {
      currentConsent.current = null;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (open && reopened.current)
      banner.current?.focus({ preventScroll: true });
  }, [open]);

  function choose(value: Exclude<AnalyticsConsent, null>) {
    // The SDK keeps its script after unmounting; its callback must see revocation immediately.
    currentConsent.current = value;
    setConsent(value);
    try {
      window.localStorage.setItem(consentStorageKey, value);
      setStorageUnavailable(false);
    } catch {
      setStorageUnavailable(true);
    }
    setOpen(false);
    if (reopened.current)
      settingsButton.current?.focus({ preventScroll: true });
    reopened.current = false;
  }

  return (
    <>
      <button
        ref={settingsButton}
        type="button"
        className="hover:text-primary-text"
        aria-expanded={open}
        aria-controls="cookie-preferences"
        onClick={() => {
          reopened.current = true;
          setOpen(true);
        }}
      >
        Cookie settings
      </button>
      {consent === "accepted" && (
        <Analytics
          beforeSend={(event) => consentedEvent(event, currentConsent.current)}
        />
      )}
      {open &&
        createPortal(
          <section
            ref={banner}
            id="cookie-preferences"
            aria-labelledby="cookie-preferences-heading"
            tabIndex={-1}
            className="fixed inset-x-4 bottom-4 z-50 max-h-[80dvh] overflow-y-auto rounded-xl border bg-card pb-[env(safe-area-inset-bottom)] text-foreground shadow-xl sm:right-auto sm:bottom-6 sm:left-6 sm:max-w-sm"
          >
            <div className="flex flex-col gap-4 p-5">
              <div>
                <h2
                  id="cookie-preferences-heading"
                  className="text-sm font-medium tracking-tight"
                >
                  Cookies & privacy
                </h2>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Optional, cookie-free analytics help us understand site
                  visits. They stay off unless you accept. We save your choice
                  in this browser.{" "}
                  <a
                    href="/privacy#cookies"
                    className="text-primary-text underline underline-offset-4"
                  >
                    Privacy Policy
                  </a>
                </p>
                {consent !== null && (
                  <p
                    className="mt-3 text-xs text-muted-foreground"
                    role="status"
                  >
                    Analytics is currently{" "}
                    {consent === "accepted" ? "on" : "off"}.
                    {storageUnavailable &&
                      " Browser storage is unavailable; your choice applies to this visit only."}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="button button-outline min-h-9 px-3 text-xs"
                  onClick={() => choose("rejected")}
                >
                  Reject optional
                </button>
                <button
                  type="button"
                  className="button button-outline min-h-9 px-3 text-xs"
                  onClick={() => choose("accepted")}
                >
                  Accept analytics
                </button>
              </div>
            </div>
          </section>,
          document.body
        )}
    </>
  );
}
