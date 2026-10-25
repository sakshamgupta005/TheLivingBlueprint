import React from 'react';
import { ArchitecturalRoom, RoomStatus } from '../types';
import type { RiskTier } from '../domain/resilience/types.ts';

interface IsometricHouseProps {
  rooms: ArchitecturalRoom[];
  selectedRoomId: string | null;
  onSelectRoom: (room: ArchitecturalRoom) => void;
  foundationTechnologies?: string[];
  riskByRoomId?: Record<string, RiskTier>;
  cascadePath?: string[];
  isCalming?: boolean;
  containedLabel?: string | null;
  isEarlyState?: boolean;
}

const ORIGIN_X = 450;
const ORIGIN_Y = 320;

function toIso(x: number, y: number, z: number) {
  return {
    x: Number((ORIGIN_X + (x - y) * 0.866).toFixed(1)),
    y: Number((ORIGIN_Y + (x + y) * 0.5 - z).toFixed(1)),
  };
}

function polyPoints(pts: Array<{ x: number; y: number }>) {
  return pts.map((p) => `${p.x},${p.y}`).join(' ');
}

export const IsometricHouse: React.FC<IsometricHouseProps> = ({
  rooms,
  selectedRoomId,
  onSelectRoom,
  foundationTechnologies,
  riskByRoomId,
  cascadePath,
  isCalming = false,
  containedLabel,
  isEarlyState = false,
}) => {
  const [activeCascadeHop, setActiveCascadeHop] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (cascadePath && cascadePath.length > 1) {
      setActiveCascadeHop(0);
    }
  }, [cascadePath?.join('>')]);

  React.useEffect(() => {
    if (activeCascadeHop === null || !cascadePath || cascadePath.length <= 1) return;
    if (activeCascadeHop >= cascadePath.length) {
      const timer = window.setTimeout(() => setActiveCascadeHop(null), 1200);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setActiveCascadeHop((h) => (h !== null ? h + 1 : null));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeCascadeHop, cascadePath?.length]);
  // Foundation slab coordinates
  const foundation = {
    x: -190,
    y: -150,
    w: 380,
    d: 300,
    h: 22,
    baseZ: -24,
  };

  const fTop = [
    toIso(foundation.x, foundation.y, 0),
    toIso(foundation.x + foundation.w, foundation.y, 0),
    toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
    toIso(foundation.x, foundation.y + foundation.d, 0),
  ];

  const fLeft = [
    toIso(foundation.x, foundation.y + foundation.d, foundation.baseZ),
    toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
    toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
    toIso(foundation.x, foundation.y + foundation.d, 0),
  ];

  const fRight = [
    toIso(foundation.x + foundation.w, foundation.y, foundation.baseZ),
    toIso(foundation.x + foundation.w, foundation.y + foundation.d, foundation.baseZ),
    toIso(foundation.x + foundation.w, foundation.y + foundation.d, 0),
    toIso(foundation.x + foundation.w, foundation.y, 0),
  ];

  // Foundation pillars supporting the house platform
  const pillars = [
    { x: -180, y: -140, w: 16, d: 16, h: 40, z: -64 },
    { x: 164, y: -140, w: 16, d: 16, h: 40, z: -64 },
    { x: -180, y: 134, w: 16, d: 16, h: 40, z: -64 },
    { x: 164, y: 134, w: 16, d: 16, h: 40, z: -64 },
    { x: -8, y: -140, w: 16, d: 16, h: 40, z: -64 },
    { x: -8, y: 134, w: 16, d: 16, h: 40, z: -64 },
  ];

  // Roof coordinates
  const roof = {
    x: -190,
    y: -150,
    w: 380,
    d: 300,
    baseZ: 145,
    peakZ: 195,
  };

  const roofGableFront = [
    toIso(roof.x, roof.y + roof.d, roof.baseZ),
    toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
    toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
  ];

  const roofLeftSlope = [
    toIso(roof.x, roof.y, roof.baseZ),
    toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
    toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
    toIso(roof.x, roof.y + roof.d, roof.baseZ),
  ];

  const roofRightSlope = [
    toIso(roof.x + roof.w / 2, roof.y, roof.peakZ),
    toIso(roof.x + roof.w, roof.y, roof.baseZ),
    toIso(roof.x + roof.w, roof.y + roof.d, roof.baseZ),
    toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ),
  ];


  const getRoomStyles = (status: RoomStatus, isSelected: boolean) => {
    switch (status) {
      case 'verified':
        return {
          topFill: isSelected ? '#4A6149' : '#3E4E3D',
          leftFill: isSelected ? '#3D503C' : '#313E30',
          rightFill: isSelected ? '#435842' : '#384637',
          stroke: isSelected ? '#86AB83' : '#5B7A58',
          dash: 'none',
          badgeText: '✓ Verified',
          badgeBg: '#2C392C',
          badgeColor: '#A8D4A5',
        };
      case 'implemented':
      case 'in_progress':
        return {
          topFill: isSelected ? '#635133' : '#52432A',
          leftFill: isSelected ? '#4F4028' : '#3F3420',
          rightFill: isSelected ? '#57462C' : '#473A25',
          stroke: isSelected ? '#C49B52' : '#9E7A3E',
          dash: 'none',
          badgeText: '⚡ Implemented',
          badgeBg: '#3D311F',
          badgeColor: '#E0B565',
        };
      case 'planned':
        return {
          topFill: isSelected ? 'rgba(80, 71, 67, 0.45)' : 'rgba(56, 48, 45, 0.35)',
          leftFill: isSelected ? 'rgba(64, 56, 53, 0.45)' : 'rgba(44, 38, 35, 0.35)',
          rightFill: isSelected ? 'rgba(72, 63, 60, 0.45)' : 'rgba(50, 43, 40, 0.35)',
          stroke: isSelected ? '#B0A29C' : '#7A706B',
          dash: '5,4',
          badgeText: '○ Planned',
          badgeBg: '#2E2725',
          badgeColor: '#9C908B',
        };
      case 'blocked':
        return {
          topFill: isSelected ? '#6D3838' : '#572C2C',
          leftFill: isSelected ? '#552B2B' : '#432222',
          rightFill: isSelected ? '#613131' : '#4C2727',
          stroke: isSelected ? '#C76363' : '#9E4A4A',
          dash: 'none',
          badgeText: '✕ Blocked',
          badgeBg: '#3C2020',
          badgeColor: '#E28383',
        };
      case 'unknown':
        return {
          topFill: isSelected ? '#4F4756' : '#3E3744',
          leftFill: isSelected ? '#3E3745' : '#2F2B36',
          rightFill: isSelected ? '#463E4D' : '#36313C',
          stroke: isSelected ? '#9A8AA8' : '#766782',
          dash: '3,3',
          badgeText: '? Unknown',
          badgeBg: '#2E2835',
          badgeColor: '#B6A6C5',
        };
    }
  };

  return (
    <svg
      viewBox="0 0 900 640"
      className="isometric-house-svg"
      role="img"
      aria-label="Interactive Software Architecture House"
    >
      <defs>
        {/* Striped construction pattern for WIP state */}
        <pattern
          id="construction-stripe"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="12" stroke="#9E7A3E" strokeWidth="3" opacity="0.4" />
        </pattern>

        {/* Subtle drop shadow filter for floating roofs & selected rooms */}
        <filter id="soft-shadow" x="-10%" y="-10%" width="130%" height="130%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000000" floodOpacity="0.4" />
        </filter>

        {/* Operational risk failed hatch pattern overlay (Part 2.5) */}
        <pattern
          id="risk-hatch"
          width="8"
          height="8"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="8" stroke="var(--risk-failed)" strokeWidth="2.5" opacity="0.6" />
        </pattern>
      </defs>

      {/* 1. Structural Ground Pillars (Sub-foundation bedrock) */}
      <g className="structural-pillars">
        {pillars.map((p, idx) => {
          const pLeft = [
            toIso(p.x, p.y + p.d, p.z),
            toIso(p.x + p.w, p.y + p.d, p.z),
            toIso(p.x + p.w, p.y + p.d, p.z + p.h),
            toIso(p.x, p.y + p.d, p.z + p.h),
          ];
          const pRight = [
            toIso(p.x + p.w, p.y, p.z),
            toIso(p.x + p.w, p.y + p.d, p.z),
            toIso(p.x + p.w, p.y + p.d, p.z + p.h),
            toIso(p.x + p.w, p.y, p.z + p.h),
          ];
          return (
            <g key={`pillar-${idx}`}>
              <polygon points={polyPoints(pLeft)} fill="#221A1A" stroke="#3A2D2D" strokeWidth="1" />
              <polygon points={polyPoints(pRight)} fill="#1A1414" stroke="#3A2D2D" strokeWidth="1" />
            </g>
          );
        })}
      </g>

      {/* 2. Concrete Foundation Base Slab */}
      <g className="foundation-slab">
        <polygon points={polyPoints(fLeft)} fill="#241C1C" stroke="#443535" strokeWidth="1.2" />
        <polygon points={polyPoints(fRight)} fill="#1C1616" stroke="#443535" strokeWidth="1.2" />
        <polygon points={polyPoints(fTop)} fill="#332727" stroke="#4E3D3D" strokeWidth="1.5" />

        {/* Foundation Grid Accent lines */}
        <line
          x1={toIso(foundation.x, 0, 0).x}
          y1={toIso(foundation.x, 0, 0).y}
          x2={toIso(foundation.x + foundation.w, 0, 0).x}
          y2={toIso(foundation.x + foundation.w, 0, 0).y}
          stroke="#423232"
          strokeWidth="1"
          strokeDasharray="4,4"
        />
        <line
          x1={toIso(0, foundation.y, 0).x}
          y1={toIso(0, foundation.y, 0).y}
          x2={toIso(0, foundation.y + foundation.d, 0).x}
          y2={toIso(0, foundation.y + foundation.d, 0).y}
          stroke="#423232"
          strokeWidth="1"
          strokeDasharray="4,4"
        />

        {/* Foundation Label on Front Rim */}
        <text
          x={toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).x}
          y={toIso(-20, foundation.y + foundation.d + 12, foundation.baseZ / 2).y}
          fill="#8C7A70"
          fontSize="10"
          fontFamily="ui-monospace, monospace"
          letterSpacing="1.2"
          fontWeight="600"
          transform="rotate(18, 450, 480)"
          pointerEvents="none"
        >
          {foundationTechnologies && foundationTechnologies.length > 0
            ? `FOUNDATION: ${foundationTechnologies.slice(0, 3).map((t) => t.toUpperCase()).join(' · ')} · REPO ROOT`
            : 'FOUNDATION: REPOSITORY ROOT · RUNTIME PLATFORM'}
        </text>
      </g>

      {/* 3. Architectural Rooms (Sorted back-to-front for proper isometric depth and hit testing) */}
      <g className="rooms-layer">
        {[...rooms]
          .sort((a, b) => {
            const depthA = (a.coords?.isoX ?? 0) + (a.coords?.isoY ?? 0);
            const depthB = (b.coords?.isoX ?? 0) + (b.coords?.isoY ?? 0);
            return depthA - depthB;
          })
          .map((room) => {
            const coords = {
              x: room.coords?.isoX ?? 0,
              y: room.coords?.isoY ?? 0,
              w: room.coords?.width ?? 160,
              d: room.coords?.depth ?? 120,
              h: room.coords?.height ?? 80,
              z: 0,
            };

            const isSelected = selectedRoomId === room.id;
            const styles = getRoomStyles(room.status, isSelected);

            const rTop = [
              toIso(coords.x, coords.y, coords.z + coords.h),
              toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
              toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
              toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
            ];

            const rLeft = [
              toIso(coords.x, coords.y + coords.d, coords.z),
              toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
              toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
              toIso(coords.x, coords.y + coords.d, coords.z + coords.h),
            ];

            const rRight = [
              toIso(coords.x + coords.w, coords.y, coords.z),
              toIso(coords.x + coords.w, coords.y + coords.d, coords.z),
              toIso(coords.x + coords.w, coords.y + coords.d, coords.z + coords.h),
              toIso(coords.x + coords.w, coords.y, coords.z + coords.h),
            ];

            // Center coordinate for room label and badge
            const centerIso = toIso(
              coords.x + coords.w / 2,
              coords.y + coords.d / 2,
              coords.z + coords.h
            );

            return (
              <g
                key={room.id}
                id={`room-node-${room.id}`}
                className={`room-group ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectRoom(room)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectRoom(room);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`${room.name} (${room.status})`}
                aria-pressed={isSelected}
                style={{ cursor: 'pointer', outline: 'none' }}
              >
                {/* Left Face */}
                <polygon
                  points={polyPoints(rLeft)}
                  fill={styles.leftFill}
                  stroke={isSelected ? '#FFD166' : styles.stroke}
                  strokeWidth={isSelected ? '2' : '1.2'}
                  strokeDasharray={styles.dash}
                />

                {/* Right Face */}
                <polygon
                  points={polyPoints(rRight)}
                  fill={styles.rightFill}
                  stroke={isSelected ? '#FFD166' : styles.stroke}
                  strokeWidth={isSelected ? '2' : '1.2'}
                  strokeDasharray={styles.dash}
                />

                {/* Top Face */}
                <polygon
                  points={polyPoints(rTop)}
                  fill={styles.topFill}
                  stroke={isSelected ? '#FFE5A3' : styles.stroke}
                  strokeWidth={isSelected ? '2.5' : '1.4'}
                  strokeDasharray={styles.dash}
                />

                {/* Highlight outline when selected */}
                {isSelected && (
                  <polygon
                    points={polyPoints(rTop)}
                    fill="none"
                    stroke="#FFD166"
                    strokeWidth="3.5"
                    opacity="0.8"
                    pointerEvents="none"
                  />
                )}

                {/* WIP Pattern overlay for under-construction rooms */}
                {room.status === 'in_progress' && (
                  <polygon
                    points={polyPoints(rTop)}
                    fill="url(#construction-stripe)"
                    pointerEvents="none"
                  />
                )}

                {/* Operational Risk Overlay (Part 2.5) - Rings pulse by tier, calm down after fix */}
                {(() => {
                  const riskTier = riskByRoomId ? riskByRoomId[room.id] : undefined;
                  if (!riskTier || riskTier === 'healthy') return null;

                  const calmingClass = isCalming ? 'risk-ring-calming' : '';

                  if (riskTier === 'failed') {
                    return (
                      <g pointerEvents="none" className={`risk-ring-failed-group ${calmingClass}`}>
                        <polygon
                          points={polyPoints(rTop)}
                          fill="url(#risk-hatch)"
                          opacity="0.35"
                          className="risk-hatch-fill"
                        />
                        <polygon
                          points={polyPoints(rTop)}
                          fill="none"
                          stroke="var(--risk-failed)"
                          strokeWidth="3"
                          strokeDasharray="6,4"
                          className={`risk-ring-pulse-failed ${calmingClass}`}
                        />
                      </g>
                    );
                  }

                  if (riskTier === 'critical') {
                    return (
                      <polygon
                        points={polyPoints(rTop)}
                        fill="none"
                        stroke="var(--risk-critical)"
                        strokeWidth="3.5"
                        filter="drop-shadow(0 0 10px var(--risk-glow-critical))"
                        pointerEvents="none"
                        className={`risk-ring-pulse-critical ${calmingClass}`}
                      />
                    );
                  }

                  if (riskTier === 'high') {
                    return (
                      <polygon
                        points={polyPoints(rTop)}
                        fill="none"
                        stroke="var(--risk-high)"
                        strokeWidth="3"
                        filter="drop-shadow(0 0 6px var(--risk-glow-high))"
                        pointerEvents="none"
                        className={`risk-ring-pulse-high ${calmingClass}`}
                      />
                    );
                  }

                  if (riskTier === 'watch') {
                    return (
                      <polygon
                        points={polyPoints(rTop)}
                        fill="none"
                        stroke="var(--risk-watch)"
                        strokeWidth="2"
                        pointerEvents="none"
                        className={`risk-ring-pulse-watch ${calmingClass}`}
                      />
                    );
                  }

                  return null;
                })()}

                {/* Cascade Hop Indicator along Path */}
                {(() => {
                  if (!cascadePath || cascadePath.length === 0) return null;
                  const hopIdx = cascadePath.indexOf(room.id);
                  if (hopIdx === -1) return null;
                  const isCurrentHop = activeCascadeHop === hopIdx;
                  return (
                    <g pointerEvents="none">
                      {isCurrentHop && (
                        <polygon
                          points={polyPoints(rTop)}
                          fill="none"
                          stroke="var(--risk-critical)"
                          strokeWidth="4"
                          className="cascade-hop-active-pulse"
                        />
                      )}
                      <g transform={`translate(${centerIso.x + 36}, ${centerIso.y - 18})`}>
                        <rect
                          x="-14"
                          y="-8"
                          width="28"
                          height="14"
                          rx="3"
                          fill="rgba(30, 20, 18, 0.9)"
                          stroke={isCurrentHop ? 'var(--risk-critical)' : 'var(--border-subtle)'}
                          strokeWidth="1"
                        />
                        <text
                          x="0"
                          y="2"
                          textAnchor="middle"
                          fill={isCurrentHop ? 'var(--risk-critical)' : 'var(--text-muted)'}
                          fontSize="8"
                          fontFamily="var(--font-mono)"
                          fontWeight="700"
                        >
                          hop {hopIdx + 1}
                        </text>
                      </g>
                    </g>
                  );
                })()}

                {/* Room Name & Status Tag on Top Face */}
                <g pointerEvents="none" transform={`translate(${centerIso.x}, ${centerIso.y - 10})`}>
                  <text
                    x="0"
                    y="-4"
                    textAnchor="middle"
                    fill="#E6DFDA"
                    fontSize="11"
                    fontWeight="600"
                    fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                  >
                    {room.name}
                  </text>
                  <rect
                    x="-36"
                    y="5"
                    width="72"
                    height="16"
                    rx="3"
                    fill={styles.badgeBg}
                    stroke={isSelected ? '#FFD166' : styles.stroke}
                    strokeWidth="0.8"
                  />
                  <text
                    x="0"
                    y="16"
                    textAnchor="middle"
                    fill={styles.badgeColor}
                    fontSize="9"
                    fontFamily="ui-monospace, monospace"
                    fontWeight="600"
                  >
                    {styles.badgeText}
                  </text>
                </g>
              </g>
            );
          })}
      </g>

      {/* 4. Roof Structure (Transparent architectural canopy / trusses) */}
      <g className="roof-structure" opacity="0.85" pointerEvents="none">
        {/* Support columns from rooms up to roof */}
        <line
          x1={toIso(-170, -130, 80).x}
          y1={toIso(-170, -130, 80).y}
          x2={toIso(-170, -130, 145).x}
          y2={toIso(-170, -130, 145).y}
          stroke="#5C4B4B"
          strokeWidth="2"
        />
        <line
          x1={toIso(170, -130, 80).x}
          y1={toIso(170, -130, 80).y}
          x2={toIso(170, -130, 145).x}
          y2={toIso(170, -130, 145).y}
          stroke="#5C4B4B"
          strokeWidth="2"
        />
        <line
          x1={toIso(-170, 130, 80).x}
          y1={toIso(-170, 130, 80).y}
          x2={toIso(-170, 130, 145).x}
          y2={toIso(-170, 130, 145).y}
          stroke="#5C4B4B"
          strokeWidth="2"
        />
        <line
          x1={toIso(170, 130, 80).x}
          y1={toIso(170, 130, 80).y}
          x2={toIso(170, 130, 145).x}
          y2={toIso(170, 130, 145).y}
          stroke="#5C4B4B"
          strokeWidth="2"
        />

        {/* Roof Left Slope */}
        <polygon
          points={polyPoints(roofLeftSlope)}
          fill="rgba(66, 52, 52, 0.4)"
          stroke="#7A6060"
          strokeWidth="1.2"
        />

        {/* Roof Right Slope */}
        <polygon
          points={polyPoints(roofRightSlope)}
          fill="rgba(54, 42, 42, 0.4)"
          stroke="#7A6060"
          strokeWidth="1.2"
        />

        {/* Roof Front Gable Wireframe */}
        <polygon
          points={polyPoints(roofGableFront)}
          fill="rgba(74, 58, 58, 0.25)"
          stroke="#8A6E6E"
          strokeWidth="1.5"
        />

        {/* Roof Ridge Beam */}
        <line
          x1={toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).x}
          y1={toIso(roof.x + roof.w / 2, roof.y, roof.peakZ).y}
          x2={toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).x}
          y2={toIso(roof.x + roof.w / 2, roof.y + roof.d, roof.peakZ).y}
          stroke="#A88B8B"
          strokeWidth="2"
        />

        {/* Antenna / Gateway Spire */}
        <line
          x1={toIso(0, 0, roof.peakZ).x}
          y1={toIso(0, 0, roof.peakZ).y}
          x2={toIso(0, 0, roof.peakZ + 35).x}
          y2={toIso(0, 0, roof.peakZ + 35).y}
          stroke="#A88B8B"
          strokeWidth="1.5"
        />
        <circle
          cx={toIso(0, 0, roof.peakZ + 35).x}
          cy={toIso(0, 0, roof.peakZ + 35).y}
          r="3"
          fill="#C49B52"
        />
        <text
          x={toIso(0, 0, roof.peakZ + 45).x}
          y={toIso(0, 0, roof.peakZ + 45).y}
          textAnchor="middle"
          fill="#8C7A70"
          fontSize="9"
          fontFamily="ui-monospace, monospace"
        >
          API GATEWAY & ROUTING
        </text>
      </g>

      {/* Contained containment notice overlay */}
      {containedLabel && (
        <g className="house-contained-indicator" transform="translate(450, 42)">
          <rect
            x="-120"
            y="-16"
            width="240"
            height="32"
            rx="6"
            fill="rgba(24, 38, 28, 0.95)"
            stroke="var(--status-verified)"
            strokeWidth="1.5"
          />
          <text
            x="0"
            y="5"
            textAnchor="middle"
            fill="var(--recommend)"
            fontSize="12"
            fontFamily="var(--font-mono)"
            fontWeight="700"
          >
            {containedLabel}
          </text>
        </g>
      )}

      {/* Early / Normal traffic prompt overlay (t < 12) */}
      {isEarlyState && (
        <g className="house-early-state-indicator" transform="translate(450, 42)">
          <rect
            x="-175"
            y="-16"
            width="350"
            height="32"
            rx="6"
            fill="rgba(30, 24, 22, 0.92)"
            stroke="var(--border-subtle)"
            strokeWidth="1"
          />
          <text
            x="0"
            y="5"
            textAnchor="middle"
            fill="var(--text-secondary)"
            fontSize="11"
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
            fontWeight="500"
          >
            Watching normal traffic… press ▶ to start the incident
          </text>
        </g>
      )}
    </svg>
  );
};
