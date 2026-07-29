'use client';

import { useEffect, useRef } from 'react';
import { RobotOutlined, UserOutlined, VideoCameraAddOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { Button, Flex, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { Track } from 'livekit-client';
import type { AgentModality } from '@/lib/contract';

/**
 * The face-to-face surface for a video-capable agent.
 *
 * Two tiles: the agent's avatar (the remote video the worker publishes) and the
 * caller's self-view (the local camera). The session hands us LiveKit `Track`s and
 * we attach them here with `track.attach()` — the DOM stays out of the transport.
 *
 * It renders whenever the *agent* is video-capable, not only once video is flowing,
 * so the tiles are honest placeholders before a call and while we wait for the
 * avatar to arrive — never a black rectangle pretending to be a stream.
 */

const useStyles = createStyles(({ token, css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    @media (min-width: 480px) {
      grid-template-columns: 1fr 1fr;
    }
  `,
  tile: css`
    position: relative;
    aspect-ratio: 4 / 3;
    border-radius: ${token.borderRadiusLG}px;
    overflow: hidden;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
    display: flex;
    align-items: center;
    justify-content: center;
  `,
  video: css`
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  `,
  mirror: css`
    transform: scaleX(-1);
  `,
  badge: css`
    position: absolute;
    left: 8px;
    bottom: 8px;
    z-index: 2;
  `,
  placeholder: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    color: ${token.colorTextTertiary};
    font-size: 12px;
    text-align: center;
    padding: 0 16px;
  `,
  pulse: css`
    font-size: 30px;
    color: ${token.colorTextQuaternary};
    animation: videoStagePulse 1.8s ease-in-out infinite;
    @keyframes videoStagePulse {
      0%,
      100% {
        opacity: 0.35;
      }
      50% {
        opacity: 0.85;
      }
    }
  `,
}));

/** Attaches a LiveKit video `Track` to a real `<video>` element and cleans up. */
function VideoTile({
  track,
  muted,
  mirror,
  badge,
  placeholder,
}: {
  track: Track | null;
  muted?: boolean;
  mirror?: boolean;
  badge: React.ReactNode;
  placeholder: React.ReactNode;
}) {
  const { styles, cx } = useStyles();
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    // `attach(el)` wires the track's MediaStream onto our own element (rather than
    // creating a detached one), so React keeps ownership of the node.
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div className={styles.tile}>
      {track ? (
        <video
          ref={ref}
          className={cx(styles.video, mirror && styles.mirror)}
          autoPlay
          playsInline
          muted={muted}
        />
      ) : (
        <div className={styles.placeholder}>{placeholder}</div>
      )}
      <div className={styles.badge}>{badge}</div>
    </div>
  );
}

export function VideoStage({
  agentName,
  modality,
  running,
  localTrack,
  remoteTrack,
  videoActive,
  canToggle,
  onToggleVideo,
}: {
  agentName: string;
  /** The agent's declared modality — decides whether the escalate control shows. */
  modality: AgentModality;
  running: boolean;
  localTrack: Track | null;
  remoteTrack: Track | null;
  videoActive: boolean;
  /** True once the live transport is running and can publish the camera. */
  canToggle: boolean;
  onToggleVideo: () => void;
}) {
  const { styles } = useStyles();

  return (
    <Flex vertical gap={10}>
      <Flex align="center" justify="space-between" gap={8} wrap="wrap">
        <Flex align="center" gap={8}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            Video
          </Typography.Text>
          <Tag bordered={false} color={modality === 'video' ? 'geekblue' : 'purple'}>
            {modality === 'video' ? 'video call' : 'voice + video'}
          </Tag>
        </Flex>
        {/* `both` is voice-first, so the caller opts in; `video` is on from the
            start but can still be turned off. The control is live only while a call
            is running against the real transport. */}
        <Tooltip
          title={
            canToggle
              ? videoActive
                ? 'Stop your camera and continue on audio.'
                : 'Turn your camera on. The agent sees your video and you see its avatar.'
              : 'Start a live call to turn on video.'
          }
        >
          <Button
            size="small"
            type={videoActive ? 'default' : 'primary'}
            danger={videoActive}
            disabled={!canToggle}
            icon={videoActive ? <VideoCameraOutlined /> : <VideoCameraAddOutlined />}
            onClick={onToggleVideo}
          >
            {videoActive ? 'Turn off camera' : 'Escalate to video'}
          </Button>
        </Tooltip>
      </Flex>

      <div className={styles.grid}>
        <VideoTile
          track={remoteTrack}
          badge={
            <Tag bordered={false} color={remoteTrack ? 'green' : 'default'}>
              {agentName}
            </Tag>
          }
          placeholder={
            <>
              <RobotOutlined className={running ? styles.pulse : undefined} style={{ fontSize: 30 }} />
              <span>
                {running
                  ? 'Waiting for the agent avatar…'
                  : 'The agent avatar appears here during a call.'}
              </span>
            </>
          }
        />
        <VideoTile
          track={localTrack}
          muted
          mirror
          badge={
            <Tag bordered={false} color={localTrack ? 'blue' : 'default'}>
              You
            </Tag>
          }
          placeholder={
            <>
              <UserOutlined style={{ fontSize: 30 }} />
              <span>
                {videoActive ? 'Starting your camera…' : 'Your camera is off.'}
              </span>
            </>
          }
        />
      </div>
    </Flex>
  );
}
