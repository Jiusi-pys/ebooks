namespace Shufang.Updates;

// Launch metadata only. The shared core checks the persisted database identity.
public static class NodeIdentity
{
    public static string Validate(string value)
    {
        if (value.Length is < 1 or > 128 || value.Any(c => !char.IsAsciiLetterOrDigit(c) && !"_.:-".Contains(c)))
            throw new InvalidDataException("节点和工作区 ID 必须为 1–128 位字母、数字或 _ . : -");
        return value;
    }
    public static string Argument(string[] args, string name, string fallback)
    {
        var indices = Enumerable.Range(0, args.Length).Where(i => args[i] == name).ToArray();
        if (indices.Length == 0) return Validate(fallback);
        if (indices.Length != 1 || indices[0] + 1 >= args.Length) throw new InvalidDataException("缺少或重复的节点身份参数");
        return Validate(args[indices[0] + 1]);
    }
}
