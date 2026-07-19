using JunoBridge.Core;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    internal static class JobsHandler
    {
        public static BridgeResponse Get(string jobId)
        {
            var job = JobRegistry.Find(jobId);
            if (job == null)
                return BridgeResponse.Error(404, "unknown_job", "No job with id '" + jobId + "'.");
            return BridgeResponse.Ok(JobRegistry.ToJson(job));
        }
    }
}
