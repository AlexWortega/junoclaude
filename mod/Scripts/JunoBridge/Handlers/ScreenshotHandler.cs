using System;
using JunoBridge.Net;
using UnityEngine;

namespace JunoBridge.Handlers
{
    /// Runs exclusively from the end-of-frame queue: on Metal, capturing before rendering
    /// finishes yields a black or torn frame.
    internal static class ScreenshotHandler
    {
        private const int DefaultWidth = 1280;

        public static BridgeResponse Capture(BridgeRequest request)
        {
            int width = request.QInt("w", DefaultWidth);
            int height = request.QInt("h", 0);

            Texture2D captured = null;
            Texture2D scaled = null;

            try
            {
                captured = ScreenCapture.CaptureScreenshotAsTexture();
                if (captured == null)
                    return BridgeResponse.Error(500, "screenshot_failed", "Screen capture returned no texture.");

                Texture2D source = captured;
                if (width > 0 && width < captured.width)
                {
                    if (height <= 0)
                        height = Mathf.Max(1, Mathf.RoundToInt(captured.height * (width / (float)captured.width)));
                    scaled = Downscale(captured, width, height);
                    source = scaled;
                }

                byte[] png = source.EncodeToPNG();
                if (png == null)
                    return BridgeResponse.Error(500, "screenshot_encode_failed", "PNG encoding returned no data.");

                return BridgeResponse.Binary("image/png", png);
            }
            catch (Exception ex)
            {
                return BridgeResponse.Error(500, "screenshot_exception", ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                if (captured != null) UnityEngine.Object.Destroy(captured);
                if (scaled != null) UnityEngine.Object.Destroy(scaled);
            }
        }

        private static Texture2D Downscale(Texture2D source, int width, int height)
        {
            var target = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            var previous = RenderTexture.active;

            try
            {
                Graphics.Blit(source, target);
                RenderTexture.active = target;

                var result = new Texture2D(width, height, TextureFormat.RGB24, false);
                result.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                result.Apply();
                return result;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
            }
        }
    }
}
