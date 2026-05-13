function appendFullFormatAndFill() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName("Raw Data");
  const formatSheet = ss.getSheetByName("Format");

  const rawData = rawSheet.getDataRange().getValues();
  const headers = rawData[0];

  const siteCol = headers.indexOf("Site Name");
  const dateCol = headers.indexOf("Report Date");

  // detect inverter columns
  const invCols = headers
    .map((h, i) => ({ name: h, index: i }))
    .filter(h => h.name.toString().startsWith("Inv"))
    .sort((a, b) => Number(a.name.split(" ")[1]) - Number(b.name.split(" ")[1]));

  const TEMPLATE_ROWS = 15;
  const TEMPLATE_COLS = 25;

  const formatData = formatSheet.getDataRange().getValues();

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const siteName = row[siteCol];
    const reportDate = row[dateCol];

    if (!siteName) continue;

    // 🔥 COUNT inverter values in raw data
    const invCount = invCols.filter(inv => Number(row[inv.index]) > 0).length;

    // 🔍 FIND FORMAT BASED ONLY ON INVERTER COUNT
    let formatStartRow = -1;

    for (let r = 0; r < formatData.length; r++) {

      let formatInvCount = 0;

      for (let c = 0; c < formatData[r].length; c++) {
        if (String(formatData[r][c]).includes("Inverter")) {
          formatInvCount++;
        }
      }

      // 🎯 MATCH FORMAT TYPE
      if (formatInvCount === invCount) {
        formatStartRow = r + 1;
        break;
      }
    }

    if (formatStartRow === -1) {
      Logger.log(`❌ No matching format for ${siteName} (${invCount} INV)`);
      continue;
    }

    const formatRange = formatSheet.getRange(formatStartRow, 1, TEMPLATE_ROWS, TEMPLATE_COLS);

    // ✅ Get or create sheet
    let sheet = ss.getSheetByName(siteName);

    if (!sheet) {
      sheet = ss.insertSheet(siteName);
      formatRange.copyTo(sheet.getRange(1, 1));
      SpreadsheetApp.flush();
    }

    let startRow;
    let template;

    if (sheet.getLastRow() === 0) {
      template = formatRange;
      startRow = 1;
    } else {
      template = sheet.getRange(1, 1, TEMPLATE_ROWS, TEMPLATE_COLS);
      startRow = sheet.getLastRow() + 2;
    }

    // 📌 COPY TEMPLATE
    const target = sheet.getRange(startRow, 1, TEMPLATE_ROWS, TEMPLATE_COLS);
    template.copyTo(target);
    SpreadsheetApp.flush();

    const block = sheet.getRange(startRow, 1, TEMPLATE_ROWS, TEMPLATE_COLS).getValues();

    let genRow = -1;
    let headerRow = -1;
    let dateRow = -1;

    for (let r = 0; r < block.length; r++) {
      for (let c = 0; c < block[r].length; c++) {
        if (block[r][c] === "Generation") genRow = r;
        if (block[r][c] === "Inverter 1") headerRow = r;
        if (block[r][c] === "DATE") dateRow = r;
      }
    }

    if (genRow === -1 || headerRow === -1) {
      Logger.log(`Format issue in ${siteName}`);
      continue;
    }

    // 📌 Fill DATE
    if (dateRow !== -1) {
      sheet.getRange(startRow + dateRow, 2).setValue(new Date(reportDate));
    }

    // 📌 Fill inverter values
    let total = 0;

    invCols.forEach(inv => {
      const invNumber = inv.name.split(" ")[1];
      const value = Number(row[inv.index]) || 0;

      for (let c = 0; c < block[headerRow].length; c++) {
        if (block[headerRow][c] === `Inverter ${invNumber}`) {
          sheet.getRange(startRow + genRow, c + 1).setValue(value);
          total += value;
        }
      }
    });

    // 📌 Fill Total
    for (let c = 0; c < block[headerRow].length; c++) {
      if (block[headerRow][c] === "Total") {
        sheet.getRange(startRow + genRow, c + 1).setValue(total);
        break;
      }
    }
  }
}