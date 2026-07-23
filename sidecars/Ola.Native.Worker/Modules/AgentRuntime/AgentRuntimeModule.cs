internal sealed class AgentRuntimeModule : IWorkerModule
{
    public string Name => "agent-runtime";

    public void Register(WorkerModuleContext context)
    {
        AgentRuntimeDebugPayload.CleanupTempFiles();
        context.Register(AgentRuntimeContract.InitializeRoute, AgentRuntimeTools.Initialize);
        context.Register(AgentRuntimeContract.PingRoute, AgentRuntimeTools.Ping);
        context.Register(AgentRuntimeContract.ShutdownRoute, AgentRuntimeTools.Shutdown);
        context.Register(AgentRuntimeContract.CapabilitiesCheckRoute, AgentRuntimeTools.CheckCapability);
        context.Register(AgentRuntimeContract.RunRoute, AgentRuntimeTools.RunAsync);
        context.Register(AgentRuntimeContract.ActiveRunsRoute, AgentRuntimeTools.ActiveRunList);
        context.Register(AgentRuntimeContract.RunStatusRoute, AgentRuntimeTools.RunStatus);
        context.Register(AgentRuntimeContract.RunSnapshotRoute, AgentRuntimeTools.RunSnapshot);
        context.Register(AgentRuntimeContract.CancelRoute, AgentRuntimeTools.Cancel);
        context.Register(AgentRuntimeContract.RequestStopRoute, AgentRuntimeTools.RequestStop);
        context.Register(AgentRuntimeContract.AppendMessagesRoute, AgentRuntimeTools.AppendMessages);
        context.Register(AgentRuntimeContract.CompressContextRoute, AgentRuntimeContextCompression.CompressAsync);
        context.Register(AgentRuntimeContract.DebugBodyReadRoute, AgentRuntimeDebugPayload.ReadBody);
        context.Register(AgentRuntimeContract.ReverseResponseRoute, AgentRuntimeTools.ReverseResponse);
        context.Register(AgentRuntimeContract.ReverseCancelRoute, AgentRuntimeTools.ReverseCancel);
        context.Register(AgentRuntimeContract.SessionVisibilityRoute, AgentRuntimeTools.SessionVisibility);
        context.Register("team-runtime/create", AgentRuntimeTeamRuntimeApi.Create);
        context.Register("team-runtime/delete", AgentRuntimeTeamRuntimeApi.Delete);
        context.Register("team-runtime/message-append", AgentRuntimeTeamRuntimeApi.AppendMessage);
        context.Register("team-runtime/snapshot", AgentRuntimeTeamRuntimeApi.Snapshot);
        context.Register("team-runtime/member-update", AgentRuntimeTeamRuntimeApi.UpdateMember);
        context.Register("team-runtime/manifest-update", AgentRuntimeTeamRuntimeApi.UpdateManifest);
        context.Register("team-runtime/messages-consume", AgentRuntimeTeamRuntimeApi.ConsumeMessages);
    }
}
