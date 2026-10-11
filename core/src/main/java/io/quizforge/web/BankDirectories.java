package io.quizforge.web;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** A directory containing bank.json is a bank with assets, not an extra group. */
final class BankDirectories {
    record Scan(List<Path> banks, List<Path> groups) { }
    static Scan scan(Path root) {
        var banks = new ArrayList<Path>(); var groups = new ArrayList<Path>();
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) return new Scan(List.of(), List.of());
        try { walk(root.toAbsolutePath().normalize(), 0, banks, groups); }
        catch (IOException e) { throw new ApiException(422, "INVALID_BANK_DIRECTORIES", e.getMessage()); }
        return new Scan(List.copyOf(banks), List.copyOf(groups));
    }
    private static void walk(Path directory, int depth, List<Path> banks, List<Path> groups) throws IOException {
        LibraryManagement.checkPath(directory);
        if (depth > 0 && Files.exists(directory.resolve("bank.json"), LinkOption.NOFOLLOW_LINKS)) {
            if (depth > 2) throw new IOException("题库分组只支持一层：" + directory);
            Path bank = directory.resolve("bank.json"); LibraryManagement.checkPath(bank);
            if (!Files.isRegularFile(bank, LinkOption.NOFOLLOW_LINKS)) throw new IOException("bank.json must be a file");
            banks.add(bank); return;
        }
        if (depth > 1) throw new IOException("题库分组只支持一层：" + directory);
        if (groups.size() >= 1000) throw new IOException("题库分组数量不能超过 1000");
        if (depth > 0) groups.add(directory);
        try (var files = Files.list(directory)) {
            var entries = files.sorted().limit(2001).toList();
            if (entries.size() > 2000) throw new IOException("分组中的文件数量不能超过 2000");
            for (Path file : entries) {
                if (Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)) walk(file, depth + 1, banks, groups);
                else if (Files.isSymbolicLink(file)) throw new IOException("题库目录不能包含链接");
                else if (file.getFileName().toString().endsWith(".json")) { LibraryManagement.checkPath(file); banks.add(file); }
                if (banks.size() > 1000) throw new IOException("题库数量不能超过 1000");
            }
        }
    }
    static Path item(Path base, Path bank) { return bank.getFileName().toString().equals("bank.json") && !bank.getParent().equals(base) ? bank.getParent() : bank; }
}
