"use client";

import { useEffect, useRef, useState } from "react";
import { avatarTone, initials } from "@/lib/risk";
import { shouldResetAvatarError } from "@/lib/avatar-error-reset";

interface PersonAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}

export function PersonAvatar({ name, avatarUrl, size = 32, className }: PersonAvatarProps) {
  const [errored, setErrored] = useState(false);
  // A still-mounted row (keyed by stable row.id, polled in place every ~10s)
  // can receive a different, valid avatarUrl over time because LinkedIn avatar
  // URLs are signed and rotate. Without this reset the stale errored flag keeps
  // showImage=false forever, so the new image is never attempted and the
  // documented "next scan refreshes the row" recovery never fires.
  const lastUrlRef = useRef(avatarUrl);
  useEffect(() => {
    if (shouldResetAvatarError(lastUrlRef.current, avatarUrl)) {
      lastUrlRef.current = avatarUrl;
      setErrored(false);
    }
  }, [avatarUrl]);
  const showImage = Boolean(avatarUrl) && !errored;
  const fontSize = Math.max(10, Math.round(size * 0.375));
  const baseClass =
    "grid place-items-center overflow-hidden rounded-full font-display font-semibold text-white";
  const merged = className ? `${baseClass} ${className}` : baseClass;

  if (showImage) {
    return (
      <span
        className={merged}
        style={{ width: size, height: size, background: avatarTone(name) }}
      >
        {/* Hotlinked LinkedIn avatar - URL is signed and may expire. onError
        falls through to the initials tile until the next scan refreshes the
        row. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl as string}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={merged}
      style={{
        width: size,
        height: size,
        background: avatarTone(name),
        fontSize
      }}
    >
      {initials(name)}
    </span>
  );
}
