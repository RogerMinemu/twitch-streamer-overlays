// DirectShow ARGB capture helper.
//
// WHY THIS EXISTS: Chromium converts every webcam frame to YUV (I420), which has no alpha
// channel, so NVIDIA Broadcast's native transparency never reaches getUserMedia. This helper
// reads the virtual camera through DirectShow in ARGB32 (exactly like OBS does) and streams
// raw BGRA frames to the Electron main process over stdout.
//
// Compiled on demand with the C# compiler that ships with Windows (.NET Framework 4, C# 5):
//   csc /nologo /codepage:65001 /unsafe /optimize+ /platform:x64 /target:exe /out:dshow-capture.exe dshow-capture.cs
//
// Usage:
//   dshow-capture.exe --list                                   formats of every camera (JSON)
//   dshow-capture.exe --probe-connect --device "<name>"        which formats the camera really accepts
//   dshow-capture.exe --capture --device "<name>" --width <min> --height <min>
//
// Capture protocol (stdout): repeated [16-byte header][width*height*4 bytes BGRA, top-down rows]
//   header = "FRM1" | int32 width | int32 height | int32 flags (reserved, 0)
// The output is downscaled by an integer factor to the smallest size >= --width/--height.
// Events go to stderr as one JSON object per line. Exits when stdin closes (parent gone).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace OverlayCapture
{
    static class Guids
    {
        public static readonly Guid SystemDeviceEnum = new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86");
        public static readonly Guid VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
        public static readonly Guid FilterGraph = new Guid("e436ebb3-524f-11ce-9f53-0020af0ba770");
        public static readonly Guid CaptureGraphBuilder2 = new Guid("BF87B6E1-8C27-11d0-B3F0-00AA003761C5");
        public static readonly Guid SampleGrabber = new Guid("C1F400A0-3F08-11d3-9F0B-006008039E37");
        public static readonly Guid NullRenderer = new Guid("C1F400A4-3F08-11d3-9F0B-006008039E37");

        public static readonly Guid IBaseFilter = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");
        public static readonly Guid IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");
        public static readonly Guid IAMStreamConfig = new Guid("C6E13340-30AC-11d0-A18C-00A0C9118956");

        public static readonly Guid PinCategoryCapture = new Guid("fb6c4281-0353-11d1-905f-0000c0cc16ba");
        public static readonly Guid MediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
        public static readonly Guid FormatVideoInfo = new Guid("05589f80-c356-11ce-bf01-00aa0055595a");
        public static readonly Guid FormatVideoInfo2 = new Guid("F72A76A0-EB0A-11d0-ACE4-0000C0CC16BA");

        public static readonly Guid SubtypeARGB32 = new Guid("773c9ac0-3274-11d0-b724-00aa006c1a01");
        public static readonly Guid SubtypeRGB32 = new Guid("e436eb7e-524f-11ce-9f53-0020af0ba770");
        public static readonly Guid SubtypeRGB24 = new Guid("e436eb7d-524f-11ce-9f53-0020af0ba770");
    }

    // ------------------------------------------------------------------ COM interop
    // Only the vtable slots we call are declared (order matters, trailing slots can be omitted).

    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICreateDevEnum
    {
        [PreserveSig] int CreateClassEnumerator([In] ref Guid deviceClass, out IEnumMoniker enumMoniker, int flags);
    }

    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyBag
    {
        [PreserveSig] int Read([In, MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] out object value, IntPtr errorLog);
    }

    [ComImport, Guid("56a86895-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IBaseFilter
    {
        [PreserveSig] int GetClassID(out Guid classId);
        [PreserveSig] int Stop();
        [PreserveSig] int Pause();
        [PreserveSig] int Run(long start);
        [PreserveSig] int GetState(int timeout, out int state);
        [PreserveSig] int SetSyncSource(IntPtr clock);
        [PreserveSig] int GetSyncSource(out IntPtr clock);
        [PreserveSig] int EnumPins(out IEnumPins pins);
    }

    [ComImport, Guid("56a86899-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMediaFilter
    {
        [PreserveSig] int GetClassID(out Guid classId);
        [PreserveSig] int Stop();
        [PreserveSig] int Pause();
        [PreserveSig] int Run(long start);
        [PreserveSig] int GetState(int timeout, out int state);
        [PreserveSig] int SetSyncSource(IntPtr clock);
    }

    [ComImport, Guid("56a86892-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumPins
    {
        [PreserveSig] int Next(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] IPin[] pins, IntPtr fetched);
    }

    [ComImport, Guid("56a86891-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPin
    {
        [PreserveSig] int Connect(IntPtr receivePin, IntPtr mediaType);
        [PreserveSig] int ReceiveConnection(IntPtr connector, IntPtr mediaType);
        [PreserveSig] int Disconnect();
        [PreserveSig] int ConnectedTo(out IntPtr pin);
        [PreserveSig] int ConnectionMediaType(IntPtr mediaType);
        [PreserveSig] int QueryPinInfo(IntPtr info);
        [PreserveSig] int QueryDirection(out int direction); // 0 = input, 1 = output
        [PreserveSig] int QueryId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int QueryAccept(IntPtr mediaType);
        [PreserveSig] int EnumMediaTypes(out IEnumMediaTypes mediaTypes);
    }

    [ComImport, Guid("89c31040-846b-11ce-97d3-00aa0055595a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEnumMediaTypes
    {
        [PreserveSig] int Next(int count, out IntPtr mediaType, IntPtr fetched);
    }

    [ComImport, Guid("56a868a9-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphBuilder
    {
        [PreserveSig] int AddFilter([In] IBaseFilter filter, [In, MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int RemoveFilter([In] IBaseFilter filter);
        [PreserveSig] int EnumFilters(out IntPtr filters);
        [PreserveSig] int FindFilterByName([In, MarshalAs(UnmanagedType.LPWStr)] string name, out IntPtr filter);
        [PreserveSig] int ConnectDirect([In] IPin output, [In] IPin input, [In] IntPtr mediaType);
    }

    [ComImport, Guid("56a868b1-0ad4-11ce-b03a-0020af0ba770"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    interface IMediaControl
    {
        [PreserveSig] int Run();
        [PreserveSig] int Pause();
        [PreserveSig] int Stop();
    }

    [ComImport, Guid("93E5A4E0-2D50-11d2-ABFA-00A0C9C6E38D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICaptureGraphBuilder2
    {
        [PreserveSig] int SetFiltergraph([In] IGraphBuilder graph);
        [PreserveSig] int GetFiltergraph(out IntPtr graph);
        [PreserveSig] int SetOutputFileName(IntPtr type, IntPtr file, IntPtr filter, IntPtr sink);
        [PreserveSig] int FindInterface([In] ref Guid category, [In] ref Guid type, [In] IBaseFilter filter, [In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object result);
    }

    [ComImport, Guid("C6E13340-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAMStreamConfig
    {
        [PreserveSig] int SetFormat([In] IntPtr mediaType);
        [PreserveSig] int GetFormat(out IntPtr mediaType);
        [PreserveSig] int GetNumberOfCapabilities(out int count, out int size);
        [PreserveSig] int GetStreamCaps(int index, out IntPtr mediaType, IntPtr caps);
    }

    [ComImport, Guid("6B652FFF-11FE-4fce-92AD-0266B5D7C78F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISampleGrabber
    {
        [PreserveSig] int SetOneShot([MarshalAs(UnmanagedType.Bool)] bool oneShot);
        [PreserveSig] int SetMediaType([In] IntPtr mediaType);
        [PreserveSig] int GetConnectedMediaType([In] IntPtr mediaType);
        [PreserveSig] int SetBufferSamples([MarshalAs(UnmanagedType.Bool)] bool bufferSamples);
        [PreserveSig] int GetCurrentBuffer(ref int size, IntPtr buffer);
        [PreserveSig] int GetCurrentSample(out IntPtr sample);
        [PreserveSig] int SetCallback(ISampleGrabberCB callback, int whichMethod);
    }

    [ComImport, Guid("0579154A-2B53-4994-B0D0-E773148EFF85"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISampleGrabberCB
    {
        [PreserveSig] int SampleCB(double sampleTime, IntPtr sample);
        [PreserveSig] int BufferCB(double sampleTime, IntPtr buffer, int bufferLength);
    }

    // ------------------------------------------------------------------ media types

    /// AM_MEDIA_TYPE read/written through raw pointers (x64 layout).
    static class MediaType
    {
        const int MajorType = 0, SubType = 16, FormatType = 44, Unknown = 64, FormatPtr = 80, StructSize = 88;

        public static Guid Major(IntPtr mt) { return ReadGuid(mt, MajorType); }
        public static Guid Sub(IntPtr mt) { return ReadGuid(mt, SubType); }
        public static Guid Format(IntPtr mt) { return ReadGuid(mt, FormatType); }

        public static IntPtr Allocate(Guid major, Guid sub)
        {
            IntPtr mt = Marshal.AllocCoTaskMem(StructSize);
            for (int i = 0; i < StructSize; i++) Marshal.WriteByte(mt, i, 0);
            WriteGuid(mt, MajorType, major);
            WriteGuid(mt, SubType, sub);
            return mt;
        }

        /// Returns false if the format block isn't a VIDEOINFOHEADER(2). height > 0 means bottom-up rows.
        public static bool TryReadVideo(IntPtr mt, out int width, out int height, out int bitCount, out double fps)
        {
            width = height = bitCount = 0;
            fps = 0;
            Guid format = ReadGuid(mt, FormatType);
            IntPtr block = Marshal.ReadIntPtr(mt, FormatPtr);
            if (block == IntPtr.Zero) return false;

            int header;
            if (format == Guids.FormatVideoInfo) header = 48;
            else if (format == Guids.FormatVideoInfo2) header = 72;
            else return false;

            long frameTime = Marshal.ReadInt64(block, 40); // AvgTimePerFrame, 100 ns units
            width = Marshal.ReadInt32(block, header + 4);
            height = Marshal.ReadInt32(block, header + 8);
            bitCount = Marshal.ReadInt16(block, header + 14);
            fps = frameTime > 0 ? 10000000.0 / frameTime : 0;
            return true;
        }

        public static void Free(IntPtr mt)
        {
            if (mt == IntPtr.Zero) return;
            IntPtr block = Marshal.ReadIntPtr(mt, FormatPtr);
            if (block != IntPtr.Zero) Marshal.FreeCoTaskMem(block);
            IntPtr unknown = Marshal.ReadIntPtr(mt, Unknown);
            if (unknown != IntPtr.Zero) Marshal.Release(unknown);
            Marshal.FreeCoTaskMem(mt);
        }

        public static string SubtypeName(Guid sub)
        {
            if (sub == Guids.SubtypeARGB32) return "ARGB32";
            if (sub == Guids.SubtypeRGB32) return "RGB32";
            if (sub == Guids.SubtypeRGB24) return "RGB24";
            byte[] bytes = sub.ToByteArray();
            bool fourCC = true;
            for (int i = 0; i < 4; i++) if (bytes[i] < 32 || bytes[i] > 126) fourCC = false;
            return fourCC ? Encoding.ASCII.GetString(bytes, 0, 4).Trim() : sub.ToString();
        }

        static Guid ReadGuid(IntPtr ptr, int offset)
        {
            byte[] bytes = new byte[16];
            Marshal.Copy(IntPtr.Add(ptr, offset), bytes, 0, 16);
            return new Guid(bytes);
        }

        static void WriteGuid(IntPtr ptr, int offset, Guid value)
        {
            Marshal.Copy(value.ToByteArray(), 0, IntPtr.Add(ptr, offset), 16);
        }
    }

    class VideoFormat
    {
        public string Subtype;
        public int Width;
        public int Height;
        public int BitCount;
        public double Fps;
    }

    class Device
    {
        public string Name;
        public IMoniker Moniker;
    }

    // ------------------------------------------------------------------ frame output

    /// Receives every frame on DirectShow's streaming thread, downscales it by an integer factor,
    /// flips it to top-down and writes it to stdout. A slow reader blocks this thread, so the camera
    /// simply drops frames upstream: natural backpressure.
    unsafe class FrameSink : ISampleGrabberCB
    {
        readonly Stream output;
        readonly byte[] header = new byte[16];
        readonly byte[] frame;
        readonly int sourceWidth, sourceHeight, factor;
        public readonly int Width, Height;
        readonly bool bottomUp;

        public FrameSink(Stream output, int sourceWidth, int sourceHeight, bool bottomUp, int factor)
        {
            this.output = output;
            this.sourceWidth = sourceWidth;
            this.sourceHeight = sourceHeight;
            this.bottomUp = bottomUp;
            this.factor = factor;
            Width = sourceWidth / factor;
            Height = sourceHeight / factor;
            frame = new byte[Width * Height * 4];

            Encoding.ASCII.GetBytes("FRM1").CopyTo(header, 0);
            BitConverter.GetBytes(Width).CopyTo(header, 4);
            BitConverter.GetBytes(Height).CopyTo(header, 8);
            BitConverter.GetBytes(0).CopyTo(header, 12); // always top-down after our flip
        }

        public int SampleCB(double sampleTime, IntPtr sample) { return 0; }

        public int BufferCB(double sampleTime, IntPtr buffer, int bufferLength)
        {
            int stride = sourceWidth * 4;
            if (bufferLength < stride * sourceHeight) return 0;

            byte* source = (byte*)buffer.ToPointer();
            fixed (byte* target = frame)
            {
                if (factor == 1) CopyFlipped(source, target, stride);
                else Downscale(source, target, stride);
            }

            try
            {
                output.Write(header, 0, header.Length);
                output.Write(frame, 0, frame.Length);
                output.Flush();
            }
            catch (IOException)
            {
                Environment.Exit(0); // Electron closed the pipe
            }
            return 0;
        }

        void CopyFlipped(byte* source, byte* target, int stride)
        {
            for (int y = 0; y < Height; y++)
            {
                int row = bottomUp ? sourceHeight - 1 - y : y;
                Buffer.MemoryCopy(source + (long)row * stride, target + (long)y * stride, stride, stride);
            }
        }

        /// Averages the central 2x2 pixels of each factor×factor block: 4 reads per output pixel,
        /// so 4K → 960x540 costs ~2M reads instead of 8M, with far less aliasing than nearest-neighbour.
        void Downscale(byte* source, byte* target, int stride)
        {
            int offset = (factor - 2) / 2;
            byte* output = target;
            for (int y = 0; y < Height; y++)
            {
                int top = y * factor + offset;
                int row0 = bottomUp ? sourceHeight - 1 - top : top;
                int row1 = bottomUp ? row0 - 1 : row0 + 1;
                byte* line0 = source + (long)row0 * stride;
                byte* line1 = source + (long)row1 * stride;

                for (int x = 0; x < Width; x++)
                {
                    int left = (x * factor + offset) * 4;
                    byte* a = line0 + left;
                    byte* b = line1 + left;
                    output[0] = (byte)((a[0] + a[4] + b[0] + b[4] + 2) >> 2);
                    output[1] = (byte)((a[1] + a[5] + b[1] + b[5] + 2) >> 2);
                    output[2] = (byte)((a[2] + a[6] + b[2] + b[6] + 2) >> 2);
                    output[3] = (byte)((a[3] + a[7] + b[3] + b[7] + 2) >> 2);
                    output += 4;
                }
            }
        }
    }

    // ------------------------------------------------------------------ program

    static class Program
    {
        // Explicit UTF-8: the default console encoding (OEM codepage) would garble accents for Node.
        static readonly TextWriter Events = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };

        [MTAThread]
        static int Main(string[] args)
        {
            try
            {
                if (HasFlag(args, "--list")) return ListDevices();
                if (HasFlag(args, "--probe-connect")) return ProbeConnect(Option(args, "--device", "NVIDIA Broadcast"));
                if (HasFlag(args, "--capture"))
                {
                    return Capture(
                        Option(args, "--device", "NVIDIA Broadcast"),
                        int.Parse(Option(args, "--width", "1280"), CultureInfo.InvariantCulture),
                        int.Parse(Option(args, "--height", "720"), CultureInfo.InvariantCulture));
                }
                Emit("error", "Unknown command. Use --list or --capture.");
                return 2;
            }
            catch (Exception error)
            {
                Emit("error", error.Message);
                return 1;
            }
        }

        // ------------------------------------------------------------ capture

        static int Capture(string deviceQuery, int minWidth, int minHeight)
        {
            Device device = FindDevice(deviceQuery);
            if (device == null)
            {
                Emit("error", "No encuentro la cámara \"" + deviceQuery + "\". ¿Está abierto NVIDIA Broadcast?");
                return 3;
            }

            IBaseFilter source = BindFilter(device);
            IGraphBuilder graph = (IGraphBuilder)Create(Guids.FilterGraph);
            Check(graph.AddFilter(source, "Source"), "add source");

            IPin sourcePin = FindPin(source, 1);
            List<Candidate> candidates = ArgbCandidates(sourcePin, minWidth, minHeight);
            if (candidates.Count == 0)
            {
                Emit("error", "La cámara \"" + device.Name + "\" no ofrece ARGB32 (transparencia).");
                return 4;
            }

            IBaseFilter grabberFilter = (IBaseFilter)Create(Guids.SampleGrabber);
            ISampleGrabber grabber = (ISampleGrabber)grabberFilter;
            IntPtr accepted = MediaType.Allocate(Guids.MediaTypeVideo, Guids.SubtypeARGB32);
            Check(grabber.SetMediaType(accepted), "grabber media type");
            MediaType.Free(accepted);
            Check(graph.AddFilter(grabberFilter, "Grabber"), "add grabber");

            IBaseFilter renderer = (IBaseFilter)Create(Guids.NullRenderer);
            Check(graph.AddFilter(renderer, "Null renderer"), "add renderer");

            // NVIDIA Broadcast LISTS 12 sizes but its pin only ACCEPTS the one configured in the
            // NVIDIA app (QueryAccept = S_FALSE for the rest). Try in order of preference, keep the first
            // accepted. There's no IAMStreamConfig, so ConnectDirect with the exact type is how we pick.
            IPin grabberInput = FindPin(grabberFilter, 0);
            int connectResult = -1;
            foreach (Candidate candidate in candidates)
            {
                if (connectResult < 0) connectResult = graph.ConnectDirect(sourcePin, grabberInput, candidate.MediaType);
                MediaType.Free(candidate.MediaType);
            }
            Check(connectResult, "connect camera");
            Check(graph.ConnectDirect(FindPin(grabberFilter, 1), FindPin(renderer, 0), IntPtr.Zero), "connect renderer");

            IntPtr connected = MediaType.Allocate(Guid.Empty, Guid.Empty);
            int width, height, bitCount;
            double fps;
            Check(grabber.GetConnectedMediaType(connected), "connected media type");
            MediaType.TryReadVideo(connected, out width, out height, out bitCount, out fps);
            MediaType.Free(connected);

            int sourceHeight = Math.Abs(height);
            int factor = Math.Max(1, Math.Min(width / Math.Max(1, minWidth), sourceHeight / Math.Max(1, minHeight)));
            FrameSink sink = new FrameSink(Console.OpenStandardOutput(), width, sourceHeight, height > 0, factor);
            Check(grabber.SetBufferSamples(false), "buffer samples");
            Check(grabber.SetOneShot(false), "one shot");
            Check(grabber.SetCallback(sink, 1), "callback");

            // No reference clock: deliver each frame as soon as it arrives instead of scheduling it.
            ((IMediaFilter)graph).SetSyncSource(IntPtr.Zero);
            Check(((IMediaControl)graph).Run(), "run graph");

            Events.WriteLine(string.Format(CultureInfo.InvariantCulture,
                "{{\"event\":\"started\",\"device\":{0},\"sourceWidth\":{1},\"sourceHeight\":{2},\"width\":{3},\"height\":{4},\"fps\":{5:0.##}}}",
                Quote(device.Name), width, sourceHeight, sink.Width, sink.Height, fps));

            // Run until the parent closes our stdin (normal stop, or Electron died).
            Stream input = Console.OpenStandardInput();
            byte[] scratch = new byte[64];
            while (input.Read(scratch, 0, scratch.Length) > 0) { }

            ((IMediaControl)graph).Stop();
            GC.KeepAlive(sink);
            return 0;
        }

        /// Diagnostic: tries to connect every media type the camera offers and reports who accepts it.
        static int ProbeConnect(string deviceQuery)
        {
            Device device = FindDevice(deviceQuery);
            IBaseFilter source = BindFilter(device);
            IGraphBuilder graph = (IGraphBuilder)Create(Guids.FilterGraph);
            graph.AddFilter(source, "Source");
            IBaseFilter grabberFilter = (IBaseFilter)Create(Guids.SampleGrabber);
            ISampleGrabber grabber = (ISampleGrabber)grabberFilter;
            graph.AddFilter(grabberFilter, "Grabber");

            IPin sourcePin = FindPin(source, 1);
            IPin grabberPin = FindPin(grabberFilter, 0);
            IEnumMediaTypes types;
            sourcePin.EnumMediaTypes(out types);
            IntPtr mt;
            int index = 0;
            while (types.Next(1, out mt, IntPtr.Zero) == 0)
            {
                int width, height, bitCount;
                double fps;
                MediaType.TryReadVideo(mt, out width, out height, out bitCount, out fps);
                IntPtr accepted = MediaType.Allocate(Guids.MediaTypeVideo, MediaType.Sub(mt));
                grabber.SetMediaType(accepted);
                MediaType.Free(accepted);

                int sourceAccepts = sourcePin.QueryAccept(mt);
                int grabberAccepts = grabberPin.QueryAccept(mt);
                int connect = graph.ConnectDirect(sourcePin, grabberPin, mt);
                Emit("probe", string.Format("#{0} {1} {2}x{3} sourceQA=0x{4:X8} grabberQA=0x{5:X8} connect=0x{6:X8}",
                    index++, MediaType.SubtypeName(MediaType.Sub(mt)), width, height, sourceAccepts, grabberAccepts, connect));
                if (connect >= 0)
                {
                    sourcePin.Disconnect();
                    grabberPin.Disconnect();
                }
                MediaType.Free(mt);
            }
            return 0;
        }

        class Candidate
        {
            public IntPtr MediaType;
            public long Area;
            public bool Covers;
        }

        /// ARGB32 types ordered by preference: smallest that covers the requested size first
        /// (less data to move), then the rest from largest to smallest.
        static List<Candidate> ArgbCandidates(IPin pin, int minWidth, int minHeight)
        {
            List<Candidate> candidates = new List<Candidate>();
            IEnumMediaTypes types;
            if (pin == null || pin.EnumMediaTypes(out types) != 0 || types == null) return candidates;

            IntPtr mt;
            while (types.Next(1, out mt, IntPtr.Zero) == 0)
            {
                int width = 0, height = 0, bitCount;
                double fps;
                bool usable = MediaType.Major(mt) == Guids.MediaTypeVideo && MediaType.Sub(mt) == Guids.SubtypeARGB32
                    && MediaType.TryReadVideo(mt, out width, out height, out bitCount, out fps);
                if (!usable)
                {
                    MediaType.Free(mt);
                    continue;
                }
                height = Math.Abs(height);
                candidates.Add(new Candidate { MediaType = mt, Area = (long)width * height, Covers = width >= minWidth && height >= minHeight });
            }

            candidates.Sort(delegate (Candidate a, Candidate b)
            {
                if (a.Covers != b.Covers) return a.Covers ? -1 : 1;
                return a.Covers ? a.Area.CompareTo(b.Area) : b.Area.CompareTo(a.Area);
            });
            return candidates;
        }

        static IPin FindPin(IBaseFilter filter, int wantedDirection)
        {
            IEnumPins pins;
            if (filter.EnumPins(out pins) != 0 || pins == null) return null;
            IPin[] pin = new IPin[1];
            while (pins.Next(1, pin, IntPtr.Zero) == 0)
            {
                int direction;
                if (pin[0].QueryDirection(out direction) == 0 && direction == wantedDirection) return pin[0];
            }
            return null;
        }

        /// Exact name first, then prefix (Chromium appends " (vid:pid)" to labels), then substring.
        static Device FindDevice(string query)
        {
            List<Device> devices = EnumerateDevices();
            string wanted = query.Trim().ToLowerInvariant();
            foreach (Device device in devices) if (device.Name.ToLowerInvariant() == wanted) return device;
            foreach (Device device in devices) if (wanted.StartsWith(device.Name.ToLowerInvariant())) return device;
            foreach (Device device in devices) if (device.Name.ToLowerInvariant().Contains(wanted)) return device;
            return null;
        }

        // ------------------------------------------------------------ listing

        static int ListDevices()
        {
            StringBuilder json = new StringBuilder("[");
            bool firstDevice = true;
            foreach (Device device in EnumerateDevices())
            {
                if (!firstDevice) json.Append(',');
                firstDevice = false;
                json.Append("{\"name\":").Append(Quote(device.Name));

                // Leftover registrations (uninstalled drivers) throw on bind: report, don't abort the listing.
                List<VideoFormat> formats;
                try
                {
                    formats = ReadFormats(device);
                }
                catch (Exception error)
                {
                    json.Append(",\"error\":").Append(Quote(error.Message)).Append(",\"formats\":[]}");
                    continue;
                }

                json.Append(",\"formats\":[");
                bool firstFormat = true;
                foreach (VideoFormat format in formats)
                {
                    if (!firstFormat) json.Append(',');
                    firstFormat = false;
                    json.AppendFormat(CultureInfo.InvariantCulture,
                        "{{\"subtype\":{0},\"width\":{1},\"height\":{2},\"bitCount\":{3},\"fps\":{4:0.##}}}",
                        Quote(format.Subtype), format.Width, format.Height, format.BitCount, format.Fps);
                }
                json.Append("]}");
            }
            json.Append(']');
            Console.Out.WriteLine(json.ToString());
            return 0;
        }

        static List<Device> EnumerateDevices()
        {
            List<Device> devices = new List<Device>();
            ICreateDevEnum enumerator = (ICreateDevEnum)Create(Guids.SystemDeviceEnum);
            Guid category = Guids.VideoInputDeviceCategory;
            IEnumMoniker monikers;
            if (enumerator.CreateClassEnumerator(ref category, out monikers, 0) != 0 || monikers == null) return devices;

            IMoniker[] batch = new IMoniker[1];
            while (monikers.Next(1, batch, IntPtr.Zero) == 0)
            {
                object bagObject;
                Guid bagId = Guids.IPropertyBag;
                batch[0].BindToStorage(null, null, ref bagId, out bagObject);
                object name;
                ((IPropertyBag)bagObject).Read("FriendlyName", out name, IntPtr.Zero);
                devices.Add(new Device { Name = name as string ?? "", Moniker = batch[0] });
            }
            return devices;
        }

        static List<VideoFormat> ReadFormats(Device device)
        {
            IBaseFilter filter = BindFilter(device);
            List<VideoFormat> formats = ReadStreamCaps(filter);
            // Some virtual cameras (NVIDIA Broadcast) don't expose IAMStreamConfig: ask the pin instead.
            if (formats.Count == 0) formats = ReadPinMediaTypes(filter);
            return formats;
        }

        static List<VideoFormat> ReadStreamCaps(IBaseFilter filter)
        {
            List<VideoFormat> formats = new List<VideoFormat>();
            IGraphBuilder graph = (IGraphBuilder)Create(Guids.FilterGraph);
            ICaptureGraphBuilder2 builder = (ICaptureGraphBuilder2)Create(Guids.CaptureGraphBuilder2);
            builder.SetFiltergraph(graph);
            graph.AddFilter(filter, "Source");

            Guid category = Guids.PinCategoryCapture;
            Guid mediaType = Guids.MediaTypeVideo;
            Guid configId = Guids.IAMStreamConfig;
            object configObject;
            if (builder.FindInterface(ref category, ref mediaType, filter, ref configId, out configObject) != 0) return formats;
            IAMStreamConfig config = configObject as IAMStreamConfig;
            if (config == null) return formats;

            int count, size;
            config.GetNumberOfCapabilities(out count, out size);
            IntPtr caps = Marshal.AllocCoTaskMem(Math.Max(size, 128));
            try
            {
                for (int i = 0; i < count; i++)
                {
                    IntPtr mt;
                    if (config.GetStreamCaps(i, out mt, caps) != 0) continue;
                    AddVideoFormat(formats, mt);
                    MediaType.Free(mt);
                }
            }
            finally
            {
                Marshal.FreeCoTaskMem(caps);
            }
            return formats;
        }

        static List<VideoFormat> ReadPinMediaTypes(IBaseFilter filter)
        {
            List<VideoFormat> formats = new List<VideoFormat>();
            IPin pin = FindPin(filter, 1);
            IEnumMediaTypes types;
            if (pin == null || pin.EnumMediaTypes(out types) != 0 || types == null) return formats;

            IntPtr mt;
            while (types.Next(1, out mt, IntPtr.Zero) == 0)
            {
                AddVideoFormat(formats, mt);
                MediaType.Free(mt);
            }
            return formats;
        }

        static void AddVideoFormat(List<VideoFormat> formats, IntPtr mt)
        {
            int width, height, bitCount;
            double fps;
            if (MediaType.Major(mt) != Guids.MediaTypeVideo || !MediaType.TryReadVideo(mt, out width, out height, out bitCount, out fps)) return;
            formats.Add(new VideoFormat
            {
                Subtype = MediaType.SubtypeName(MediaType.Sub(mt)),
                Width = width,
                Height = Math.Abs(height),
                BitCount = bitCount,
                Fps = fps
            });
        }

        // ------------------------------------------------------------ helpers

        static IBaseFilter BindFilter(Device device)
        {
            object filter;
            Guid filterId = Guids.IBaseFilter;
            device.Moniker.BindToObject(null, null, ref filterId, out filter);
            return (IBaseFilter)filter;
        }

        static object Create(Guid clsid)
        {
            return Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
        }

        static void Check(int hr, string step)
        {
            if (hr < 0) throw new COMException(string.Format("DirectShow falló en '{0}' (0x{1:X8})", step, hr), hr);
        }

        static bool HasFlag(string[] args, string flag)
        {
            return Array.IndexOf(args, flag) >= 0;
        }

        static string Option(string[] args, string name, string fallback)
        {
            int index = Array.IndexOf(args, name);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : fallback;
        }

        static void Emit(string level, string message)
        {
            Events.WriteLine("{\"event\":" + Quote(level) + ",\"message\":" + Quote(message) + "}");
        }

        static string Quote(string value)
        {
            StringBuilder builder = new StringBuilder("\"");
            foreach (char c in value ?? "")
            {
                if (c == '"' || c == '\\') builder.Append('\\').Append(c);
                else if (c < 32) builder.AppendFormat("\\u{0:x4}", (int)c);
                else builder.Append(c);
            }
            return builder.Append('"').ToString();
        }
    }
}
