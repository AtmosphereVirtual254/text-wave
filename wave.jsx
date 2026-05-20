import React, { useEffect, useRef, useState } from 'react';

// Explicit Timing & Rendering Configuration (No more springs)
const CONFIG = {
    waveSpeed: 0.0006,    // REDUCED: Slower wave propagation across the string
    pushZ: 0,             // Subtle 3D displacement
    enterDuration: 600,   // Milliseconds to smoothly roll to 90°
    warpGranularity: 512  // Geometry resolution
};

// Smooth easing function for the time-domain interpolation
function easeInOutSine(x) {
    return -(Math.cos(Math.PI * x) - 1) / 2;
}

// WebGPU WGSL Shader Code
const shaderCode = `
struct Uniforms {
  matrix : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> uniforms : Uniforms;

struct PhysicsData {
  data : array<vec2<f32>>,
};
@group(0) @binding(1) var<storage, read> physics : PhysicsData;

@group(0) @binding(2) var mySampler: sampler;
@group(0) @binding(3) var myTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) position : vec3<f32>,
  @location(1) uv : vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(in : VertexInput) -> VertexOutput {
  var out : VertexOutput;
  
  let numSegments = arrayLength(&physics.data);
  let idx = min(u32(in.uv.x * f32(numSegments)), numSegments - 1u);
  let p = physics.data[idx];
  let angle = p.x;
  let zOffset = p.y;

  let c = cos(angle);
  let s = sin(angle);
  var pos = in.position;
  
  let new_y = pos.y * c - pos.z * s;
  let new_z = pos.y * s + pos.z * c;
  pos.y = new_y;
  pos.z = new_z + zOffset;

  out.position = uniforms.matrix * vec4<f32>(pos, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VertexOutput) -> @location(0) vec4<f32> {
  // Texture is now natively transparent. Backface culling handles the occlusion.
  return textureSample(myTexture, mySampler, in.uv);
}
`;

function mat4Perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = far / (near - far);
    out[11] = -1;
    out[14] = (far * near) / (near - far);
    out[15] = 0;
    return out;
}

function mat4Translate(x, y, z) {
    const out = new Float32Array(16);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
    out[12] = x; out[13] = y; out[14] = z;
    return out;
}

function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
}

const VibeTextAnimation = () => {
    const canvasRef = useRef(null);
    const overlayRef = useRef(null);
    const [error, setError] = useState(null);
    const wavePairs = useRef([]);
    const mouse = useRef({ x: -1000, y: -1000, isHovering: false });
    const cursorRef = useRef(null);
    const cursorPhysics = useRef({ x: -1000, y: -1000 });

    // Simplified physics state: no more velocity arrays needed
    const physics = useRef(
        Array.from({ length: CONFIG.warpGranularity }).map(() => ({ angleX: 0, z: 0 }))
    );

    useEffect(() => {
        let animationFrameId;
        let isRunning = true;

        async function initWebGPU() {
            if (!navigator.gpu) {
                setError("WebGPU is not supported on this browser.");
                return;
            }

            await document.fonts.ready;

            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                setError("Failed to get WebGPU adapter.");
                return;
            }

            const device = await adapter.requestDevice();
            const context = canvasRef.current.getContext('webgpu');
            const format = navigator.gpu.getPreferredCanvasFormat();
            context.configure({ device, format, alphaMode: 'premultiplied' });

            const textCanvas = document.createElement('canvas');
            textCanvas.width = 2048;
            textCanvas.height = 512;
            const ctx = textCanvas.getContext('2d');

            // EXPLICIT TRANSPARENCY: Removes the black box hack.
            // Backface culling entirely handles hiding the text on the far side of the box.
            ctx.clearRect(0, 0, 2048, 512);

            ctx.font = '900 130px "Inter", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const text = "A FIELD OF QUIET STARS.";

            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, 1024, 64);
            ctx.fillText(text, 1024, 192);
            ctx.fillText(text, 1024, 320);

            const texture = device.createTexture({
                size: [textCanvas.width, textCanvas.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: textCanvas }, { texture }, [textCanvas.width, textCanvas.height]);
            const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

            const vertices = [];
            function addQuad(p0, p1, p2, p3, uv0, uv1, uv2, uv3) {
                vertices.push(...p0, ...uv0, ...p1, ...uv1, ...p2, ...uv2);
                vertices.push(...p0, ...uv0, ...p2, ...uv2, ...p3, ...uv3);
            }

            const N = CONFIG.warpGranularity;
            const W = 16.0;
            const H = 1.0;
            const D = 1.0;

            for (let i = 0; i < N; i++) {
                const u0 = i / N;
                const u1 = (i + 1) / N;
                const x0 = -W / 2 + u0 * W;
                const x1 = -W / 2 + u1 * W;

                addQuad([x0, H / 2, D / 2], [x0, -H / 2, D / 2], [x1, -H / 2, D / 2], [x1, H / 2, D / 2], [u0, 0], [u0, 0.25], [u1, 0.25], [u1, 0]);
                addQuad([x0, H / 2, -D / 2], [x0, H / 2, D / 2], [x1, H / 2, D / 2], [x1, H / 2, -D / 2], [u0, 0.25], [u0, 0.5], [u1, 0.5], [u1, 0.25]);
                addQuad([x0, -H / 2, D / 2], [x0, -H / 2, -D / 2], [x1, -H / 2, -D / 2], [x1, -H / 2, D / 2], [u0, 0.5], [u0, 0.75], [u1, 0.75], [u1, 0.5]);
                addQuad([x1, H / 2, -D / 2], [x1, -H / 2, -D / 2], [x0, -H / 2, -D / 2], [x0, H / 2, -D / 2], [u0, 0.75], [u0, 1.0], [u1, 1.0], [u1, 0.75]);
            }

            const vertexData = new Float32Array(vertices);
            const vertexBuffer = device.createBuffer({
                size: vertexData.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vertexBuffer, 0, vertexData);

            const uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const physicsBuffer = device.createBuffer({
                size: N * 2 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            const physicsDataArray = new Float32Array(N * 2);

            const pipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: {
                    module: device.createShaderModule({ code: shaderCode }),
                    entryPoint: 'vs_main',
                    buffers: [{
                        arrayStride: 20,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x2' }
                        ]
                    }]
                },
                fragment: {
                    module: device.createShaderModule({ code: shaderCode }),
                    entryPoint: 'fs_main',
                    targets: [{
                        format,
                        blend: {
                            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
                        }
                    }]
                },
                // BACKFACE CULLING: Safely culls the inverted geometry facing away from the camera
                primitive: { topology: 'triangle-list', cullMode: 'back' },
                depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
            });

            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: { buffer: physicsBuffer } },
                    { binding: 2, resource: sampler },
                    { binding: 3, resource: texture.createView() }
                ]
            });

            const depthTexture = device.createTexture({
                size: [canvasRef.current.width, canvasRef.current.height, 1],
                format: 'depth24plus',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });

            const aspect = canvasRef.current.width / canvasRef.current.height;
            const projMatrix = mat4Perspective(Math.PI / 4, aspect, 0.1, 100.0);
            const viewMatrix = mat4Translate(0, 0, -3.0);
            const viewProjMatrix = mat4Multiply(projMatrix, viewMatrix);
            device.queue.writeBuffer(uniformBuffer, 0, viewProjMatrix);

            const render = () => {
                if (!isRunning) return;
                const now = Date.now();

                if (cursorRef.current) {
                    if (mouse.current.isHovering) {
                        cursorPhysics.current.x += (mouse.current.x - cursorPhysics.current.x) * 0.2;
                        cursorPhysics.current.y += (mouse.current.y - cursorPhysics.current.y) * 0.2;
                        cursorRef.current.style.transform = `translate(${cursorPhysics.current.x - 16}px, ${cursorPhysics.current.y - 16}px)`;
                        cursorRef.current.style.opacity = 1;
                    } else {
                        cursorRef.current.style.opacity = 0;
                    }
                }

                // Garbage collect old waves once they have fully propagated and finished transitioning everywhere
                wavePairs.current = wavePairs.current.filter(p => {
                    if (!p.leave) return true;
                    const maxDist = Math.max(
                        Math.max(p.enter.x, 1 - p.enter.x),
                        Math.max(p.leave.x, 1 - p.leave.x)
                    );
                    const maxTime = Math.max(p.enter.time, p.leave.time) + (maxDist / CONFIG.waveSpeed) + CONFIG.enterDuration;
                    return now < maxTime + 500;
                });

                // TIME-DOMAIN EASING: Superposition of oppositely-signed step functions
                physics.current.forEach((p, i) => {
                    const cx = i / N;
                    let targetAngleX = 0;
                    let targetZ = 0;

                    for (const pair of wavePairs.current) {
                        // 1. Enter Wave Front (+1)
                        const tr_E = pair.enter.time + Math.abs(cx - pair.enter.x) / CONFIG.waveSpeed;
                        let c_E = 0;
                        if (now >= tr_E) {
                            const progress = Math.min((now - tr_E) / CONFIG.enterDuration, 1.0);
                            c_E = easeInOutSine(progress);
                        }

                        // 2. Leave Wave Front (-1)
                        let c_L = 0;
                        if (pair.leave) {
                            const tr_L = pair.leave.time + Math.abs(cx - pair.leave.x) / CONFIG.waveSpeed;
                            if (now >= tr_L) {
                                const progress = Math.min((now - tr_L) / CONFIG.enterDuration, 1.0);
                                c_L = easeInOutSine(progress);
                            }
                        }

                        const netContribution = c_E - c_L;
                        targetAngleX += netContribution * (Math.PI / 2);
                        targetZ += netContribution * CONFIG.pushZ;
                    }

                    // Clamp values to prevent extreme geometries if multiple wave pairs overlap
                    p.angleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetAngleX));
                    p.z = Math.max(-CONFIG.pushZ, Math.min(CONFIG.pushZ, targetZ));

                    physicsDataArray[i * 2 + 0] = p.angleX;
                    physicsDataArray[i * 2 + 1] = p.z;
                });

                device.queue.writeBuffer(physicsBuffer, 0, physicsDataArray);

                const commandEncoder = device.createCommandEncoder();
                const passEncoder = commandEncoder.beginRenderPass({
                    colorAttachments: [{
                        view: context.getCurrentTexture().createView(),
                        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }, // Transparent canvas background
                        loadOp: 'clear',
                        storeOp: 'store',
                    }],
                    depthStencilAttachment: {
                        view: depthTexture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: 'clear',
                        depthStoreOp: 'store',
                    }
                });

                passEncoder.setPipeline(pipeline);
                passEncoder.setBindGroup(0, bindGroup);
                passEncoder.setVertexBuffer(0, vertexBuffer);
                passEncoder.draw(vertices.length / 5);
                passEncoder.end();
                device.queue.submit([commandEncoder.finish()]);

                animationFrameId = requestAnimationFrame(render);
            };

            render();
        }

        initWebGPU();

        return () => {
            isRunning = false;
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
        };
    }, []);

    const handlePointerEnter = (e) => {
        if (!overlayRef.current) return;
        const rect = overlayRef.current.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        wavePairs.current.push({ enter: { x: nx, time: Date.now() }, leave: null });
    };

    const handlePointerLeave = (e) => {
        if (!overlayRef.current || wavePairs.current.length === 0) return;
        const rect = overlayRef.current.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const lastPair = wavePairs.current[wavePairs.current.length - 1];
        if (!lastPair.leave) {
            lastPair.leave = { x: nx, time: Date.now() };
        }
    };

    useEffect(() => {
        const handleMouseMove = (e) => { mouse.current = { x: e.clientX, y: e.clientY, isHovering: true }; };
        const handleMouseLeave = () => { mouse.current.isHovering = false; };
        window.addEventListener('mousemove', handleMouseMove);
        document.body.addEventListener('mouseleave', handleMouseLeave);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            document.body.removeEventListener('mouseleave', handleMouseLeave);
        };
    }, []);

    if (error) {
        return <div className="min-h-screen bg-black text-red-500 flex items-center justify-center font-mono">{error}</div>;
    }

    return (
        <div className="relative min-h-screen bg-[#060608] overflow-hidden flex flex-col items-center justify-center selection:bg-white/20">

            <div className="absolute inset-0 pointer-events-none z-0">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.03)_0%,transparent_70%)]" />
                <div className="absolute -bottom-32 -left-10 w-[40rem] h-[40rem] bg-indigo-600/30 rounded-full blur-[140px] mix-blend-screen" />
                <div className="absolute -bottom-40 right-10 w-[45rem] h-[45rem] bg-orange-500/20 rounded-full blur-[150px] mix-blend-screen" />
                <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[50rem] h-[30rem] bg-purple-900/20 rounded-full blur-[150px] mix-blend-screen" />
            </div>

            <div className="relative z-10 w-full max-w-[95vw] md:max-w-7xl mx-auto flex flex-col items-center cursor-crosshair">
                <div className="relative w-full aspect-[8/1] drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]">
                    <div
                        ref={overlayRef}
                        className="absolute top-[20%] bottom-[20%] left-[5%] right-[5%] z-20"
                        onPointerEnter={handlePointerEnter}
                        onPointerLeave={handlePointerLeave}
                    />
                    <canvas
                        ref={canvasRef}
                        width={1600}
                        height={200}
                        className="w-full h-full pointer-events-none mix-blend-screen"
                    />
                </div>

                <div className="mt-16 text-center flex flex-col items-center pointer-events-none">
                    <p className="text-white/40 text-sm max-w-md mx-auto leading-relaxed font-sans">
                        Hardware-accelerated. No spring loops. Powered entirely by strict time-domain easing curves and native backface culling.
                    </p>
                </div>
            </div>

            <div
                ref={cursorRef}
                className="fixed top-0 left-0 w-8 h-8 bg-white/40 rounded-full blur-[8px] pointer-events-none z-50 mix-blend-screen transition-opacity duration-300 opacity-0"
            />
        </div>
    );
};

export default VibeTextAnimation;