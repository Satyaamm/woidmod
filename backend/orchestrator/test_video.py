"""Executable proof of the video path: flow video-node execution + adaptive vision
sampling + avatar barge-in. Run from the orchestrator dir:

    .venv/bin/python test_video.py
"""

import asyncio

from src.flow_engine import FlowSpec, FlowEngine
from src.vision import VisionProcessor, SamplingPolicy
from src.avatar import AvatarOutput, WaveformAvatar

# A video flow: start → escalate → look at the item → turn the avatar on → end.
VIDEO_SPEC = {
    "version": 1,
    "entryNodeId": "start",
    "nodes": [
        {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "data": {}},
        {"id": "esc", "type": "escalate_video", "position": {"x": 0, "y": 1}, "data": {"prompt": "Mind switching to video?", "requireConsent": True}},
        {"id": "look", "type": "vision", "position": {"x": 0, "y": 2}, "data": {"target": "camera", "instruction": "Read the model number on the device", "resultVar": "modelNo"}},
        {"id": "face", "type": "avatar", "position": {"x": 0, "y": 3}, "data": {"enabled": True}},
        {"id": "end", "type": "end", "position": {"x": 0, "y": 4}, "data": {}},
    ],
    "edges": [
        {"id": "e1", "source": "start", "target": "esc"},
        {"id": "e2", "source": "esc", "target": "look", "sourceHandle": "accepted"},
        {"id": "e3", "source": "look", "target": "face"},
        {"id": "e4", "source": "face", "target": "end"},
    ],
}


def test_flow_video_nodes():
    eng = FlowEngine(FlowSpec.from_dict(VIDEO_SPEC), base_prompt="You are a support agent.")
    step = eng.begin()  # start → esc
    assert step.node.id == "esc"
    assert eng.video_action()["action"] == "escalate"

    step = eng.advance("accepted")  # esc → look
    assert step.node.type == "vision"
    va = eng.video_action()
    assert va["action"] == "look" and va["instruction"].startswith("Read the model")
    assert va["resultVar"] == "modelNo"

    step = eng.advance()  # look → face (avatar)
    assert step.node.type == "avatar"
    assert eng.video_action() == {"action": "avatar", "enabled": True}

    step = eng.advance()  # face → end
    assert eng.is_terminal()
    print("  flow video nodes: escalate → look(modelNo) → avatar(on) → end  ✓")


def test_vision_sampling():
    t = [0.0]  # controllable clock
    seen = []
    scenes = []

    async def fake_vlm(frame, instruction):
        seen.append((round(t[0], 2), instruction))
        return "a device showing model X-42"

    vp = VisionProcessor(
        fake_vlm,
        scene_sink=scenes.append,
        policy=SamplingPolicy(idle_fps=1.0, burst_fps=5.0, burst_window_s=2.0),
        clock=lambda: t[0],
    )

    async def drive():
        # Idle: at 1 fps, a frame every 0.2s → only ~every 1.0s is sampled.
        for _ in range(6):  # t = 0.0 .. 1.0
            await vp.on_frame(object())
            t[0] += 0.2
        idle_samples = len(seen)
        assert idle_samples == 2, f"idle should sample ~1/s, got {idle_samples} over 1s"

        # A `vision` node fires: burst window opens, next frame samples immediately.
        vp.request_look("Read the model number")
        await vp.on_frame(object())
        assert seen[-1][1] == "Read the model number"
        # In-burst at 5 fps (0.2s interval): over 1.0s of 0.1s-spaced frames → ~5 samples,
        # far more than the ~1 the idle rate would take in the same second.
        burst_before = len(seen)
        for _ in range(10):
            t[0] += 0.1
            await vp.on_frame(object())
        burst_samples = len(seen) - burst_before
        assert burst_samples >= 4, f"burst should sample ~5/s over 1s, got {burst_samples}"

        assert scenes and scenes[0].startswith("[Vision:")

    asyncio.run(drive())
    print(f"  vision sampling: idle≈1/s, burst≈5/s on request, scene→context  ✓  (samples={len(seen)})")


def test_avatar_bargein():
    async def drive():
        av = AvatarOutput(WaveformAvatar(publish_frame=None), enabled=True)
        assert av.active
        await av.on_audio(b"\x00\x01")
        assert av._speaking is True
        await av.on_barge_in()  # caller interrupts → face stops with the audio
        assert av._speaking is False
        # A disabled avatar is a clean no-op (audio-only call).
        off = AvatarOutput(None, enabled=False)
        assert not off.active
        await off.on_audio(b"x")

    asyncio.run(drive())
    print("  avatar: drives on TTS, clears on barge-in, no-op when disabled  ✓")


if __name__ == "__main__":
    test_flow_video_nodes()
    test_vision_sampling()
    test_avatar_bargein()
    print("PASS — video path: flow video nodes execute, vision samples adaptively, avatar tracks barge-in.")
