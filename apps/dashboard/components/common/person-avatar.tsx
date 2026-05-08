"use client";

import { useState } from "react";
import { avatarTone, initials } from "@/lib/risk";

interface PersonAvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
}

export function PersonAvatar({ name, avatarUrl, size = 32, className }: PersonAvatarProps) {
  const [errored, setErrored] = useState(false);
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
        {/* Hotlinked LinkedIn avatar — URL is signed and may expire. onError
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
