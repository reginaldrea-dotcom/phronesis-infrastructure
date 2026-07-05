-- pagebreak.lua — one authoring token, a real hard page break in every format.
-- The Sibling writes ONE token at each layer boundary:
--     ::: page-break
--     :::
-- which pandoc parses as a Div with class "page-break". This filter makes it a true break:
--   * docx: the docx writer IGNORES the .page-break class, so inject a raw OpenXML page break.
--   * html / pdf-via-weasyprint: leave the <div class="page-break"> in place; reference.css
--     (.page-break { break-before: page }) does the break. So this filter only acts for docx.
-- Design of record: Eames artifact d96dcf7b; pipeline answer Heph 63dca548.

function Div(el)
  if el.classes:includes("page-break") then
    if FORMAT == "docx" or FORMAT:match("openxml") then
      return pandoc.RawBlock("openxml", '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    end
  end
  return el
end
