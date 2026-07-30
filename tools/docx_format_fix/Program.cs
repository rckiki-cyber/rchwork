using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: DocxFormatFix <input.docx> <output.docx>");
    return 2;
}

var inputPath = Path.GetFullPath(args[0]);
var outputPath = Path.GetFullPath(args[1]);

if (!File.Exists(inputPath))
{
    Console.Error.WriteLine($"Input file does not exist: {inputPath}");
    return 3;
}

if (string.Equals(inputPath, outputPath, StringComparison.Ordinal))
{
    Console.Error.WriteLine("Input and output paths must be different.");
    return 4;
}

File.Copy(inputPath, outputPath, overwrite: true);

using (var document = WordprocessingDocument.Open(outputPath, true))
{
    var mainPart = document.MainDocumentPart
        ?? throw new InvalidDataException("The DOCX has no main document part.");
    var body = mainPart.Document.Body
        ?? throw new InvalidDataException("The DOCX has no document body.");

    RemoveExportedAgentCommentary(body);
    NormalizeStyles(mainPart);
    NormalizeTextContainer(mainPart.Document);
    FixReportAlignment(body);

    foreach (var headerPart in mainPart.HeaderParts)
    {
        if (headerPart.Header is not null)
        {
            NormalizeTextContainer(headerPart.Header);
            headerPart.Header.Save();
        }
    }

    foreach (var footerPart in mainPart.FooterParts)
    {
        if (footerPart.Footer is not null)
        {
            NormalizeTextContainer(footerPart.Footer);
            footerPart.Footer.Save();
        }
    }

    if (mainPart.FootnotesPart?.Footnotes is not null)
    {
        NormalizeTextContainer(mainPart.FootnotesPart.Footnotes);
        mainPart.FootnotesPart.Footnotes.Save();
    }

    if (mainPart.EndnotesPart?.Endnotes is not null)
    {
        NormalizeTextContainer(mainPart.EndnotesPart.Endnotes);
        mainPart.EndnotesPart.Endnotes.Save();
    }

    if (mainPart.WordprocessingCommentsPart?.Comments is not null)
    {
        NormalizeTextContainer(mainPart.WordprocessingCommentsPart.Comments);
        mainPart.WordprocessingCommentsPart.Comments.Save();
    }

    mainPart.Document.Save();
}

Console.WriteLine($"Created: {outputPath}");
return 0;

static void RemoveExportedAgentCommentary(Body body)
{
    var firstParagraph = body.Elements<Paragraph>().FirstOrDefault();
    if (firstParagraph is null)
    {
        throw new InvalidDataException("The document body contains no paragraph.");
    }

    var firstText = firstParagraph.InnerText.Trim();
    const string expectedStart = "我来为你进行关于";
    const string expectedEndMarker = "现在整合输出多源调研报告";

    if (!firstText.StartsWith(expectedStart, StringComparison.Ordinal)
        || !firstText.Contains(expectedEndMarker, StringComparison.Ordinal))
    {
        throw new InvalidDataException(
            "Safety check failed: the first paragraph does not match the known exported agent commentary.");
    }

    firstParagraph.Remove();

    var firstReportParagraph = body.Elements<Paragraph>()
        .FirstOrDefault(p => !string.IsNullOrWhiteSpace(p.InnerText));
    if (firstReportParagraph is null
        || !firstReportParagraph.InnerText.Contains("多源调研报告", StringComparison.Ordinal))
    {
        throw new InvalidDataException(
            "Safety check failed: the report title was not found after removing the agent commentary.");
    }
}

static void NormalizeStyles(MainDocumentPart mainPart)
{
    var stylesPart = mainPart.StyleDefinitionsPart
        ?? mainPart.AddNewPart<StyleDefinitionsPart>();
    stylesPart.Styles ??= new Styles();

    var docDefaults = new DocDefaults(
        new RunPropertiesDefault(
            new RunPropertiesBaseStyle(
                CreateSongtiFonts(),
                new FontSize { Val = "24" },
                new FontSizeComplexScript { Val = "24" },
                new Languages { Val = "zh-CN", EastAsia = "zh-CN" }
            )
        ),
        new ParagraphPropertiesDefault(
            new ParagraphPropertiesBaseStyle(
                new SpacingBetweenLines
                {
                    Line = "360",
                    LineRule = LineSpacingRuleValues.Auto
                }
            )
        )
    );

    stylesPart.Styles.DocDefaults?.Remove();
    stylesPart.Styles.PrependChild(docDefaults);

    foreach (var style in stylesPart.Styles.Elements<Style>())
    {
        var runProperties = style.StyleRunProperties ?? new StyleRunProperties();
        SetSongtiSmallFour(runProperties);
        style.StyleRunProperties = runProperties;

        if (style.Type?.Value == StyleValues.Paragraph)
        {
            var paragraphProperties =
                style.StyleParagraphProperties ?? new StyleParagraphProperties();
            SetOnePointFiveSpacing(paragraphProperties);
            style.StyleParagraphProperties = paragraphProperties;
        }
    }

    stylesPart.Styles.Save();
}

static void NormalizeTextContainer(OpenXmlElement root)
{
    foreach (var paragraph in root.Descendants<Paragraph>())
    {
        paragraph.ParagraphProperties ??= new ParagraphProperties();
        SetOnePointFiveSpacing(paragraph.ParagraphProperties);

        var paragraphMark = paragraph.ParagraphProperties.ParagraphMarkRunProperties;
        if (paragraphMark is not null)
        {
            SetSongtiSmallFour(paragraphMark);
        }
    }

    foreach (var run in root.Descendants<Run>())
    {
        run.RunProperties ??= new RunProperties();
        SetSongtiSmallFour(run.RunProperties);
    }
}

static void FixReportAlignment(Body body)
{
    var inReferences = false;

    foreach (var paragraph in body.Elements<Paragraph>())
    {
        var text = paragraph.InnerText.Trim();

        if (text == "七、参考文献")
        {
            inReferences = true;
            continue;
        }

        if (text.StartsWith("免责声明：", StringComparison.Ordinal))
        {
            inReferences = false;
        }

        var containsUrl =
            text.Contains("http://", StringComparison.OrdinalIgnoreCase)
            || text.Contains("https://", StringComparison.OrdinalIgnoreCase);

        if (inReferences || containsUrl)
        {
            paragraph.ParagraphProperties ??= new ParagraphProperties();
            paragraph.ParagraphProperties.Justification =
                new Justification { Val = JustificationValues.Left };
        }
    }

    foreach (var paragraph in body.Descendants<Paragraph>())
    {
        var text = paragraph.InnerText;
        if (text.Contains("http://", StringComparison.OrdinalIgnoreCase)
            || text.Contains("https://", StringComparison.OrdinalIgnoreCase))
        {
            paragraph.ParagraphProperties ??= new ParagraphProperties();
            paragraph.ParagraphProperties.Justification =
                new Justification { Val = JustificationValues.Left };
        }
    }
}

static RunFonts CreateSongtiFonts()
{
    return new RunFonts
    {
        Ascii = "宋体",
        HighAnsi = "宋体",
        EastAsia = "宋体",
        ComplexScript = "宋体"
    };
}

static void SetSongtiSmallFour(OpenXmlCompositeElement runProperties)
{
    runProperties.RemoveAllChildren<RunFonts>();
    runProperties.RemoveAllChildren<FontSize>();
    runProperties.RemoveAllChildren<FontSizeComplexScript>();

    runProperties.AddChild(CreateSongtiFonts(), throwOnError: true);
    runProperties.AddChild(new FontSize { Val = "24" }, throwOnError: true);
    runProperties.AddChild(
        new FontSizeComplexScript { Val = "24" },
        throwOnError: true);
}

static void SetOnePointFiveSpacing(OpenXmlCompositeElement paragraphProperties)
{
    var existing = paragraphProperties.GetFirstChild<SpacingBetweenLines>();
    var replacement = existing is null
        ? new SpacingBetweenLines()
        : (SpacingBetweenLines)existing.CloneNode(true);

    replacement.Line = "360";
    replacement.LineRule = LineSpacingRuleValues.Auto;

    existing?.Remove();
    paragraphProperties.AddChild(replacement, throwOnError: true);
}
