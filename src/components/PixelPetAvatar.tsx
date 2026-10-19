import React from 'react';
import type { CompanionSpeaker } from '../server/types.ts';

interface PixelPetAvatarProps {
  speaker: CompanionSpeaker;
  size?: number;
  isTyping?: boolean;
}

export const PixelPetAvatar: React.FC<PixelPetAvatarProps> = ({
  speaker,
  size = 28,
  isTyping = false,
}) => {
  const isDog = speaker === 'dog';

  return (
    <div
      className={`pixel-pet-avatar-wrapper ${speaker} ${isTyping ? 'typing' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        style={{ shapeRendering: 'crispEdges', display: 'block' }}
      >
        {isDog ? (
          // Dog (Barkley): Warm golden Shiba/caramel palette, perky ears, cream muzzle
          <g className="pet-pixels dog-pixels">
            {/* Ears */}
            <rect x="3" y="1" width="3" height="4" fill="#4A2E1E" />
            <rect x="4" y="2" width="1" height="2" fill="#E2873A" />
            <rect x="10" y="1" width="3" height="4" fill="#4A2E1E" />
            <rect x="11" y="2" width="1" height="2" fill="#E2873A" />

            {/* Head */}
            <rect x="3" y="4" width="10" height="7" fill="#C48E58" />
            <rect x="4" y="4" width="8" height="6" fill="#E2873A" />

            {/* Forehead accent */}
            <rect x="7" y="5" width="2" height="2" fill="#FBE9CF" />

            {/* Eyes */}
            <rect x="4" y="6" width="2" height="2" fill="#22150F" />
            <rect x="5" y="6" width="1" height="1" fill="#FFFFFF" />
            <rect x="10" y="6" width="2" height="2" fill="#22150F" />
            <rect x="10" y="6" width="1" height="1" fill="#FFFFFF" />

            {/* Cheeks / Muzzle */}
            <rect x="5" y="8" width="6" height="4" fill="#FBE9CF" />
            {/* Nose */}
            <rect x="7" y="8" width="2" height="2" fill="#1A0F0B" />
            {/* Mouth */}
            <rect x="7" y="10" width="2" height="1" fill="#C46C2C" />

            {/* Body base */}
            <rect x="4" y="11" width="8" height="4" fill="#C48E58" />
            <rect x="6" y="11" width="4" height="4" fill="#FBE9CF" />
            {/* Paws */}
            <rect x="4" y="14" width="2" height="1" fill="#E2C9A6" />
            <rect x="10" y="14" width="2" height="1" fill="#E2C9A6" />

            {/* Tail (animated in CSS) */}
            <rect x="1" y="10" width="2" height="3" fill="#E2873A" className="pet-tail" />
          </g>
        ) : (
          // Cat (Cleo): Sleek cool slate palette, sharp ears, observant half-closed eyes
          <g className="pet-pixels cat-pixels">
            {/* Pointed Ears */}
            <rect x="3" y="1" width="2" height="4" fill="#545B6B" />
            <rect x="4" y="2" width="1" height="2" fill="#F08D9A" />
            <rect x="11" y="1" width="2" height="4" fill="#545B6B" />
            <rect x="11" y="2" width="1" height="2" fill="#F08D9A" />

            {/* Head */}
            <rect x="3" y="4" width="10" height="7" fill="#767E8F" />
            <rect x="4" y="4" width="8" height="6" fill="#8B909A" />

            {/* Half-closed observant almond eyes */}
            <rect x="4" y="6" width="2" height="1" fill="#1B1C22" />
            <rect x="4" y="7" width="2" height="1" fill="#F5C542" />
            <rect x="10" y="6" width="2" height="1" fill="#1B1C22" />
            <rect x="10" y="7" width="2" height="1" fill="#F5C542" />

            {/* Snout & Whiskers */}
            <rect x="6" y="8" width="4" height="3" fill="#D9D4CC" />
            <rect x="7" y="8" width="2" height="1" fill="#E07A86" />
            <rect x="2" y="8" width="2" height="1" fill="#D9D4CC" />
            <rect x="12" y="8" width="2" height="1" fill="#D9D4CC" />

            {/* Body base */}
            <rect x="4" y="11" width="8" height="4" fill="#767E8F" />
            <rect x="6" y="11" width="4" height="3" fill="#D9D4CC" />
            {/* Paws */}
            <rect x="4" y="14" width="2" height="1" fill="#D9D4CC" />
            <rect x="10" y="14" width="2" height="1" fill="#D9D4CC" />

            {/* Tail (curled in CSS) */}
            <rect x="12" y="11" width="2" height="4" fill="#545B6B" className="pet-tail" />
          </g>
        )}
      </svg>
    </div>
  );
};
