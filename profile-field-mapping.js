/* Shared by the upload preview and import worker. */
self.CartDeliveryFields = (() => {
  const fields = [
    { key: 'LATITUDE', label: 'Latitude', required: true, aliases: ['lat', 'gps latitude', 'y coordinate', 'y'] },
    { key: 'LONGITUDE', label: 'Longitude', required: true, aliases: ['lon', 'lng', 'long', 'gps longitude', 'x coordinate', 'x'] },
    { key: 'ROUTE', label: 'Route', aliases: ['route number', 'route id', 'route name', 'service route'] },
    { key: 'DAY', label: 'Service day', aliases: ['service day', 'day of week', 'weekday', 'collection day', 'pickup day'] },
    { key: 'QTY', label: 'Total carts needed', aliases: ['quantity', 'cart quantity', 'cart count', 'total carts', 'number of carts'] },
    { key: 'CSADR#', label: 'House / building number', aliases: ['house number', 'address number', 'street number', 'building number'] },
    { key: 'CSSDIR', label: 'Street direction', aliases: ['street direction', 'direction', 'prefix direction'] },
    { key: 'CSSTRT', label: 'Street name / full address', aliases: ['street', 'street name', 'address', 'full address', 'service address'] },
    { key: 'CSSFUX', label: 'Street suffix (St, Rd…)', aliases: ['street suffix', 'suffix', 'street type'] },
    { key: 'BINNO', label: 'Bin / cart number', aliases: ['bin number', 'bin no', 'bin id', 'cart number', 'cart id', 'serial number'] },
    { key: 'SIZE', label: 'Cart size', aliases: ['cart size', 'bin size', 'container size'] },
    { key: 'SEQNO', label: 'Stop sequence', aliases: ['sequence', 'sequence number', 'stop sequence', 'stop number', 'seq'] },
    { key: 'del_qty', label: 'Carts already delivered', aliases: ['delivered quantity', 'delivered qty', 'carts delivered', 'delivered count'] },
    { key: 'del_status', label: 'Delivery status', aliases: ['delivery status', 'delivered status'] },
    { key: 'delivery_notes', label: 'Delivery notes', aliases: ['delivery note', 'delivery comments', 'notes', 'comments'] }
  ];
  const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  function suggest(headers) {
    const mapping = {}, hints = {}, used = new Set();
    // Reserve exact app headers before considering aliases for other fields.
    for (const field of fields) {
      const exact = headers.filter(header => normalize(header) === normalize(field.key));
      if (exact.length === 1) { mapping[field.key] = exact[0]; used.add(exact[0]); hints[field.key] = 'Exact header match'; }
    }
    for (const field of fields) {
      if (mapping[field.key]) continue;
      const matches = headers.filter(header => !used.has(header) && field.aliases.some(alias => normalize(alias) === normalize(header)));
      if (matches.length === 1) { mapping[field.key] = matches[0]; used.add(matches[0]); hints[field.key] = 'Suggested match — check the sample'; }
      else hints[field.key] = matches.length > 1 ? 'Several possible matches — choose a column' : 'No match found';
    }
    return { mapping, hints };
  }
  function errors(mapping, headers) {
    const messages = [], used = new Set();
    for (const field of fields) {
      const source = mapping[field.key];
      if (!source) { if (field.required) messages.push(`Choose a column for ${field.label.toLowerCase()}.`); continue; }
      if (!headers.includes(source)) messages.push(`The column for ${field.label.toLowerCase()} is no longer available.`);
      if (used.has(source)) messages.push(`“${source}” is assigned more than once. Choose a different column or leave a field unused.`);
      used.add(source);
    }
    return [...new Set(messages)];
  }
  function apply(row, mapping) {
    if (!mapping) return row;
    const result = { ...row };
    fields.forEach(field => { delete result[field.key]; });
    for (const field of fields) {
      const source = mapping[field.key];
      if (!source || !Object.hasOwn(row, source)) continue;
      let value = row[source];
      if (field.key === 'DAY' && typeof value === 'string') {
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const index = days.findIndex(day => [day, day.slice(0, 3)].includes(value.trim().toLowerCase()));
        if (index !== -1) value = index + 1;
      }
      result[field.key] = value;
    }
    return result;
  }
  return { fields, suggest, errors, apply };
})();
